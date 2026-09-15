/**
 * Verifies Blizzard Game Data API credentials.
 *
 * Run:  npm run check:blizzard
 *
 * Reads BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET from .env via Node's
 * --env-file. Never prints the secret — only whether auth succeeded and
 * whether a real item lookup returned the fields the metadata table needs.
 */
// Marks this file as a module. Without it TypeScript treats it as a global
// script: top-level `const id` collides with the same name in the sibling
// probe scripts, and top-level `await` is rejected.
export {}


const id = process.env['BLIZZARD_CLIENT_ID']?.trim()
const secret = process.env['BLIZZARD_CLIENT_SECRET']?.trim()
const region = (process.env['BLIZZARD_REGION']?.trim() ?? 'eu').toLowerCase()

if (!id || !secret) {
  console.error('Missing credentials.')
  console.error('Fill in BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET in .env')
  console.error('Get them at https://develop.battle.net/access/clients')
  process.exit(1)
}

console.log(`client id : ${id.slice(0, 6)}…${id.slice(-4)}  (${id.length} chars)`)
console.log(`secret    : set, ${secret.length} chars (not shown)`)
console.log(`region    : ${region}`)

// --- 1. OAuth client_credentials ------------------------------------------
const tokenRes = await fetch('https://oauth.battle.net/token', {
  method: 'POST',
  headers: {
    Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: 'grant_type=client_credentials'
})

if (!tokenRes.ok) {
  console.error(`\n✗ Auth failed: ${tokenRes.status} ${tokenRes.statusText}`)
  if (tokenRes.status === 401) console.error('  401 means the id or secret is wrong.')
  process.exit(1)
}

const token = (await tokenRes.json()) as { access_token: string; expires_in: number }
console.log(`\n✓ Auth OK — token valid for ${Math.round(token.expires_in / 3600)}h`)

// --- 2. Fetch a real item and check the fields we need ---------------------
// 271483 = Serpent Crown of the Ophidian Oracle, from fixture #1.
const itemId = 271483
const itemRes = await fetch(
  `https://${region}.api.blizzard.com/data/wow/item/${itemId}?namespace=static-${region}&locale=en_US`,
  { headers: { Authorization: `Bearer ${token.access_token}` } }
)

if (!itemRes.ok) {
  console.error(`\n✗ Item lookup failed: ${itemRes.status} ${itemRes.statusText}`)
  process.exit(1)
}

const item = (await itemRes.json()) as Record<string, unknown>
const pick = (k: string): string => {
  const v = item[k] as { name?: string; type?: string } | string | number | undefined
  if (v === undefined) return 'MISSING'
  if (typeof v === 'object') return v.name ?? v.type ?? JSON.stringify(v)
  return String(v)
}

console.log(`\n✓ Item ${itemId}: ${pick('name')}`)
console.log('\nFields needed for the metadata table:')
const needed: Array<[string, string]> = [
  ['inventory_type', pick('inventory_type')],
  ['item_class', pick('item_class')],
  ['item_subclass', pick('item_subclass')],
  ['level (ilvl)', pick('level')]
]
for (const [k, v] of needed) {
  console.log(`  ${v === 'MISSING' ? '✗' : '✓'} ${k.padEnd(20)} ${v}`)
}
console.log(`\ntop-level keys returned: ${Object.keys(item).join(', ')}`)
console.log('\nReady to build the table.')
