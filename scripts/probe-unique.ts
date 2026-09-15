/** Probes what the API exposes about unique-equipped limits. */
// Marks this file as a module. Without it TypeScript treats it as a global
// script: top-level `const id` collides with the same name in the sibling
// probe scripts, and top-level `await` is rejected.
export {}

const id = process.env['BLIZZARD_CLIENT_ID']?.trim()
const secret = process.env['BLIZZARD_CLIENT_SECRET']?.trim()
const region = (process.env['BLIZZARD_REGION']?.trim() ?? 'eu').toLowerCase()
if (!id || !secret) { console.error('Missing credentials'); process.exit(1) }

const tk = await fetch('https://oauth.battle.net/token', {
  method: 'POST',
  headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials'
})
const { access_token } = (await tk.json()) as { access_token: string }

// Crafted/embellished and trinket candidates most likely to carry a category.
const PROBES: Array<[number, string]> = [
  [244582, "Farstrider's Reinforced Faulds (crafted, quality 5)"],
  [245770, "Aln'hara Cane (crafted, quality 5)"],
  [250214, 'Lightspire Core (trinket, plain Unique-Equipped)'],
  [250215, "Freightrunner's Flask (trinket)"],
  [251786, 'Ever-Collapsing Void Fissure (trinket)'],
  [268251, 'Amulet of the Twin Fangs (neck)'],
  [193757, 'Ruby Whelp Shell (DF trinket)']
]

const seenKeys = new Set<string>()
for (const [itemId, label] of PROBES) {
  const res = await fetch(
    `https://${region}.api.blizzard.com/data/wow/item/${itemId}?namespace=static-${region}&locale=en_US`,
    { headers: { Authorization: `Bearer ${access_token}` } })
  if (!res.ok) { console.log(`${itemId} HTTP ${res.status}`); continue }
  const it = (await res.json()) as Record<string, unknown>
  const p = (it['preview_item'] ?? {}) as Record<string, unknown>
  for (const k of Object.keys(p)) seenKeys.add(k)
  const unique = p['unique_equipped']
  const limit = p['limit_category']
  console.log(`${String(itemId).padEnd(7)} ${String(it['name']).padEnd(38)}`)
  console.log(`        unique_equipped: ${unique === undefined ? '—' : JSON.stringify(unique)}`)
  console.log(`        limit_category : ${limit === undefined ? '—' : JSON.stringify(limit)}`)
  const bonus = p['bonus_list'] ?? p['crafting_reagent'] ?? undefined
  if (bonus !== undefined) console.log(`        other          : ${JSON.stringify(bonus).slice(0, 90)}`)
  console.log(`        (${label})`)
}
console.log('\nAll preview_item keys seen across probes:')
console.log('  ' + [...seenKeys].sort().join(', '))
