// Display-only metadata. Never used for simulation or equipment legality.
// Refresh API set descriptions: node --env-file=.env scripts/build-tooltip-data.mjs --refresh
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const table = read('src/core/data/items.json')
const db = read('src/core/data/db2.json')
const out = 'src/renderer/src/tooltip-data.json'
const previous = existsSync(out) ? read(out) : { sets: {} }
const items = {}
const sets = structuredClone(table.sets)
for (const [id, set] of Object.entries(sets)) Object.assign(set, previous.sets[id]?.effects ? { effects: previous.sets[id].effects } : {})
for (const season of [1, 2]) for (const i of read(`src/core/data/season${season}-gear.json`).items) {
  items[i.id] = { name: i.name, quality: i.quality.toLowerCase(), slot: i.slot, armor: i.armorClass,
    source: [i.source?.instanceName, i.source?.encounterName].filter(Boolean).join(' · '),
    effects: i.specialEffects.map(e => `${e.trigger === 'On-Equip' ? 'Equip' : e.trigger}: ${e.spellName}`) }
}
for (const i of db.craftedItems) items[i.itemId] ??= { name: i.name, slot: i.slot }
for (const [id, row] of Object.entries(table.items)) {
  if (!items[id] && !row[4]) continue
  items[id] ??= {}
  Object.assign(items[id], { quality: ['poor','common','uncommon','rare','epic','legendary','artifact','heirloom'][row[3]], setId: row[4] })
}
for (const gem of db.gems) for (const t of gem.tiers) items[t.id] = { name: gem.name, quality: ['poor','common','uncommon','rare','epic'][gem.quality], effects: [gem.effect, `Crafting quality ${t.tier}`] }
if (process.argv.includes('--refresh')) {
  const region = process.env.BLIZZARD_REGION ?? 'eu'
  const auth = await fetch('https://oauth.battle.net/token', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${process.env.BLIZZARD_CLIENT_ID}:${process.env.BLIZZARD_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
  if (!auth.ok) throw new Error(`Authentication: ${auth.status}`)
  const { access_token } = await auth.json()
  const ids = [...new Set(Object.values(items).filter(i => i.name && i.setId).map(i => i.setId))]
  for (const id of ids) {
    const res = await fetch(`https://${region}.api.blizzard.com/data/wow/item-set/${id}?namespace=static-${region}&locale=en_US`, { headers: { Authorization: `Bearer ${access_token}` } })
    if (!res.ok) throw new Error(`Set ${id}: ${res.status}`)
    const data = await res.json()
    sets[id] = { name: data.name, items: data.items.map(i => i.id), members: data.items.map(i => ({ id: i.id, name: i.name })), effects: (data.effects ?? []).map(e => ({ required: e.required_count, text: e.display_string })) }
  }
  console.log(`Fetched ${ids.length} set descriptions`)
}
for (const [id, s] of Object.entries(sets)) if (!s.members && previous.sets[id]?.members) s.members = previous.sets[id].members
writeFileSync(out, JSON.stringify({ source: 'Bundled item/DB2 data and Blizzard item-set API', items, sets, gems: db.gems, enchants: db.enchants, embellishments: db.embellishments, sockets: db.innateSockets, socketBonuses: db.socketBonusIds }))
console.log(`Wrote tooltip metadata for ${Object.keys(items).length} items`)

