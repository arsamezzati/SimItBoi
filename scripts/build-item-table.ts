/**
 * Generates the static item metadata table.
 *
 * Run: npm run build:items
 *
 * BUILD TIME ONLY. Credentials are needed to generate this table, never to run
 * SimItBoi. The output ships with the app like the simc binary, so the no-setup
 * promise holds.
 *
 * Strategy, forced by two measured API limits:
 *   - Search caps at 1000 results per query, so the id space is swept in
 *     adaptive windows that split whenever a window comes back capped.
 *   - Search omits `preview_item`, so set membership comes from the item-set
 *     endpoints instead (960 sets, far cheaper than one fetch per item).
 */
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseUniqueRule, type UniqueRule } from '../src/core/data/unique.ts'

const OUT = process.env['ITEMS_OUT'] ?? 'src/core/data/items.json'
/** Item ids observed up to ~290k; sweep beyond that for headroom. */
const MAX_ITEM_ID = 340_000
const PAGE_SIZE = 1000
const CONCURRENCY = 8

const clientId = process.env['BLIZZARD_CLIENT_ID']?.trim()
const clientSecret = process.env['BLIZZARD_CLIENT_SECRET']?.trim()
const region = (process.env['BLIZZARD_REGION']?.trim() ?? 'eu').toLowerCase()

if (!clientId || !clientSecret) {
  console.error('Missing credentials in .env — see npm run check:blizzard')
  process.exit(1)
}

const api = `https://${region}.api.blizzard.com`
const namespace = `static-${region}`

async function getToken(): Promise<string> {
  const res = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  })
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`)
  return ((await res.json()) as { access_token: string }).access_token
}

const token = await getToken()
const headers = { Authorization: `Bearer ${token}` }

let requestCount = 0
async function getJson(url: string, retries = 3): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    requestCount++
    const res = await fetch(url, { headers })
    if (res.ok) return (await res.json()) as Record<string, unknown>
    // 429 = rate limited; back off and retry.
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      continue
    }
    throw new Error(`${res.status} ${res.statusText} for ${url.slice(0, 120)}`)
  }
}

/** Runs tasks with bounded concurrency, preserving nothing but completion. */
async function pool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  })
  await Promise.all(workers)
  return results
}

interface SearchItem {
  id: number
  name?: Record<string, string>
  inventory_type?: { type?: string }
  item_class?: { id?: number }
  item_subclass?: { id?: number }
  quality?: { type?: string }
  level?: number
}

/** id -> [inventoryType, itemClassId, itemSubclassId, quality, baseLevel] */
/**
 * Quality as a small int so 106k rows stay cheap. Needed by the domain rule
 * — "epic rings and trinkets are unique-equipped" cannot be applied
 * without knowing quality.
 */
const QUALITY_CODE: Record<string, number> = {
  POOR: 0, COMMON: 1, UNCOMMON: 2, RARE: 3, EPIC: 4, LEGENDARY: 5, ARTIFACT: 6, HEIRLOOM: 7
}

type ItemRow = [string, number, number, number]
const items = new Map<number, ItemRow>()
const names = new Map<number, string>()

/**
 * Sweeps an id window, splitting it when the result set comes back capped.
 * This is what keeps every query under the 1000-result ceiling regardless of
 * how unevenly item ids are distributed.
 */
async function sweep(lo: number, hi: number, depth = 0): Promise<void> {
  const url =
    `${api}/data/wow/search/item?namespace=${namespace}` +
    `&id=[${lo},${hi}]&is_equippable=true&orderby=id&_pageSize=${PAGE_SIZE}`
  const j = await getJson(url)
  const results = (j['results'] as Array<{ data: SearchItem }> | undefined) ?? []
  const capped = j['resultCountCapped'] === true || results.length >= PAGE_SIZE

  if (capped && hi > lo) {
    const mid = Math.floor((lo + hi) / 2)
    await sweep(lo, mid, depth + 1)
    await sweep(mid + 1, hi, depth + 1)
    return
  }

  for (const { data } of results) {
    const invType = data.inventory_type?.type
    if (!invType || invType === 'NON_EQUIP') continue
    // Poor/Common gear is never a sim candidate. This is the ONLY safe trim:
    // id ranges and base item level both fail, because bonus IDs pull old items
    // up to current ilvl.
    const quality = data.quality?.type
    if (quality === 'POOR' || quality === 'COMMON') continue
    items.set(data.id, [
      invType,
      data.item_class?.id ?? -1,
      data.item_subclass?.id ?? -1,
      QUALITY_CODE[data.quality?.type ?? ''] ?? -1
    ])
    const n = data.name?.['en_US']
    if (n) names.set(data.id, n)
  }
}

console.log(`Sweeping item ids 0–${MAX_ITEM_ID.toLocaleString()} (${namespace})…`)
const started = Date.now()

// Seed with fixed windows so the top-level work can run concurrently; each
// window still splits itself adaptively when it comes back capped.
const WINDOW = 10_000
const seeds: Array<() => Promise<void>> = []
for (let lo = 0; lo < MAX_ITEM_ID; lo += WINDOW) {
  const hi = Math.min(lo + WINDOW - 1, MAX_ITEM_ID)
  seeds.push(async () => {
    await sweep(lo, hi)
    process.stdout.write(`\r  ${items.size.toLocaleString()} items · ${requestCount} requests   `)
  })
}
await pool(seeds, CONCURRENCY)
process.stdout.write('\n')

// --- Item sets: membership + bonus effects -------------------------
console.log('Fetching item sets…')
const setIndex = await getJson(`${api}/data/wow/item-set/index?namespace=${namespace}&locale=en_US`)
const setRefs = (setIndex['item_sets'] as Array<{ id: number }> | undefined) ?? []

const sets: Record<string, { name: string; items: number[] }> = {}
const itemToSet = new Map<number, number>()

await pool(
  setRefs.map((ref) => async () => {
    try {
      const s = await getJson(`${api}/data/wow/item-set/${ref.id}?namespace=${namespace}&locale=en_US`)
      const memberIds = ((s['items'] as Array<{ id: number }> | undefined) ?? []).map((i) => i.id)
      sets[String(ref.id)] = { name: String(s['name'] ?? ''), items: memberIds }
      for (const m of memberIds) itemToSet.set(m, ref.id)
      process.stdout.write(`\r  ${Object.keys(sets).length}/${setRefs.length} sets   `)
    } catch {
      /* a missing set is not fatal */
    }
  }),
  CONCURRENCY
)
process.stdout.write('\n')

// Search omits preview_item. Fetch paired-slot restrictions explicitly; fail the
// build on missing previews so an incomplete sweep cannot look unrestricted.
console.log('Fetching ring and trinket unique-equipped restrictions…')
const unique: Record<string, UniqueRule> = {}
const paired = [...items.entries()].filter(([, row]) => row[0] === 'FINGER' || row[0] === 'TRINKET')
await pool(paired.map(([id]) => async () => {
  const item = await getJson(`${api}/data/wow/item/${id}?namespace=${namespace}&locale=en_US`)
  const preview = item['preview_item'] as { unique_equipped?: string } | undefined
  if (!preview) throw new Error(`Item ${id} has no preview_item; cannot establish equipment restrictions`)
  unique[String(id)] = parseUniqueRule(preview.unique_equipped)
  if (Object.keys(unique).length % 500 === 0) console.log(`  ${Object.keys(unique).length}/${paired.length} checked`)
}), CONCURRENCY)

// --- Emit -----------------------------------------------------------------
const out = {
  version: 3,
  generated: new Date().toISOString(),
  namespace,
  note: 'Generated by scripts/build-item-table.ts.',
  schema: {
    items: 'id -> [inventoryType, itemClassId, itemSubclassId, qualityCode, setId?]',
    sets: 'setId -> { name, items[] }'
  },
  counts: { items: items.size, sets: Object.keys(sets).length },
  items: Object.fromEntries(
    [...items.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, row]) => {
        const setId = itemToSet.get(id)
        return [String(id), setId === undefined ? row : [...row, setId]]
      })
  ),
  sets,
  unique: Object.fromEntries(Object.entries(unique).sort(([a], [b]) => Number(a) - Number(b)))
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(`${OUT}.tmp`, JSON.stringify(out), 'utf8')
await rename(`${OUT}.tmp`, OUT)
const uniqueCounts: Record<string, number> = {}
for (const rule of Object.values(unique)) uniqueCounts[rule.kind] = (uniqueCounts[rule.kind] ?? 0) + 1
console.log('Unique restriction coverage:', uniqueCounts)
if (!uniqueCounts['category']) console.warn('No category strings returned by the API; cross-item category coverage is unverified.')

const byType = new Map<string, number>()
for (const [, row] of items) byType.set(row[0], (byType.get(row[0]) ?? 0) + 1)

console.log(`\nWrote ${OUT}`)
console.log(`  items    : ${items.size.toLocaleString()}`)
console.log(`  sets     : ${Object.keys(sets).length}`)
console.log(`  requests : ${requestCount.toLocaleString()}`)
console.log(`  elapsed  : ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log('\nweapon-relevant inventory types:')
for (const t of ['TWOHWEAPON', 'WEAPON', 'WEAPONMAINHAND', 'WEAPONOFFHAND', 'SHIELD', 'HOLDABLE', 'RANGED', 'RANGEDRIGHT']) {
  if (byType.has(t)) console.log(`  ${t.padEnd(16)} ${byType.get(t)!.toLocaleString()}`)
}
