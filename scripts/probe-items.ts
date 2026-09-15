/**
 * Probes a handful of real items to confirm the Blizzard API supplies every
 * field the metadata table needs before building the generator.
 *
 * Run: npm run probe:items
 */
// Marks this file as a module. Without it TypeScript treats it as a global
// script: top-level `const id` collides with the same name in the sibling
// probe scripts, and top-level `await` is rejected.
export {}

const id = process.env['BLIZZARD_CLIENT_ID']?.trim()
const secret = process.env['BLIZZARD_CLIENT_SECRET']?.trim()
const region = (process.env['BLIZZARD_REGION']?.trim() ?? 'eu').toLowerCase()
if (!id || !secret) {
  console.error('Missing credentials in .env')
  process.exit(1)
}

const tokenRes = await fetch('https://oauth.battle.net/token', {
  method: 'POST',
  headers: {
    Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: 'grant_type=client_credentials'
})
const { access_token } = (await tokenRes.json()) as { access_token: string }

/** Items chosen because each one caused, or should have prevented, a real bug. */
const PROBES: Array<[number, string]> = [
  [245770, "Aln'hara Cane — equipped 2H staff"],
  [193761, "Chillworn's Infusion Staff — suspected 2H"],
  [273778, 'Polished Lightwood Channeler — suspected 1H'],
  [251123, "Nibbles' Training Rod — handedness unknown"],
  [159664, 'Bulwark of Brimming Potential — shield (phantom upgrade case)'],
  [268224, "Venom Warden's Greaves — simc REJECTED this"],
  [271483, 'Serpent Crown — tier piece, set id?'],
  [250214, 'Lightspire Core — trinket, unique-equipped?']
]

interface ItemJson {
  name?: string
  inventory_type?: { type?: string; name?: string }
  item_class?: { name?: string }
  item_subclass?: { name?: string }
  is_equippable?: boolean
  preview_item?: {
    set?: { item_set?: { id?: number; name?: string }; display_string?: string }
    unique_equipped?: string
    binding?: { name?: string }
  }
}

console.log('id      inventory_type        class    subclass        item')
console.log('─'.repeat(86))

const extras: string[] = []
for (const [itemId, label] of PROBES) {
  const res = await fetch(
    `https://${region}.api.blizzard.com/data/wow/item/${itemId}?namespace=static-${region}&locale=en_US`,
    { headers: { Authorization: `Bearer ${access_token}` } }
  )
  if (!res.ok) {
    console.log(`${String(itemId).padEnd(7)} HTTP ${res.status} — ${label}`)
    continue
  }
  const it = (await res.json()) as ItemJson
  const inv = it.inventory_type?.name ?? it.inventory_type?.type ?? '?'
  const cls = it.item_class?.name ?? '?'
  const sub = it.item_subclass?.name ?? '?'
  console.log(
    `${String(itemId).padEnd(7)} ${inv.padEnd(21)} ${cls.padEnd(8)} ${sub.padEnd(15)} ${it.name ?? ''}`
  )

  const p = it.preview_item
  if (p?.set) {
    extras.push(`  ${itemId} SET: id=${p.set.item_set?.id} "${p.set.item_set?.name}"`)
  }
  if (p?.unique_equipped) {
    extras.push(`  ${itemId} UNIQUE-EQUIPPED: "${p.unique_equipped}"`)
  }
  console.log(`        └─ ${label}`)
}

if (extras.length > 0) {
  console.log('\nSet / unique-equipped data found:')
  for (const e of extras) console.log(e)
} else {
  console.log('\nNo set or unique-equipped data on any probe — needs investigation.')
}
