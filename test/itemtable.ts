import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { lookupItem, canEquip, setOf, itemTable } from '../src/core/data/itemTable.ts'
import { inferConfig, allowedConfigs, isLegalPair, rulesFor } from '../src/core/topgear/weapons.ts'
import { filterCandidates } from '../src/core/topgear/prepass.ts'

const profile = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
const t = itemTable()
console.log(`table: ${t.counts.items.toLocaleString()} items, ${t.counts.sets} sets, generated ${t.generated.slice(0,10)}`)

console.log('\n--- armour-class gate, against ALL bag items ---')
const unequippable = profile.bagItems.filter((c) => !canEquip(profile.className, c.item.id))
console.log(`bag items simc would reject: ${unequippable.length}`)
for (const c of unequippable) {
  const m = lookupItem(c.item.id)!
  console.log(`  ${c.name} — ${m.armorClass} (${profile.className} wears mail)`)
}

console.log('\n--- weapon typing, now from real data ---')
const weapons = [...profile.equipped, ...profile.bagItems].filter((c) =>
  c.slotClass === 'main_hand' || c.slotClass === 'off_hand')
const counts: Record<string, number> = {}
for (const c of weapons) {
  const w = lookupItem(c.item.id)?.weaponType ?? 'UNKNOWN'
  counts[w] = (counts[w] ?? 0) + 1
}
console.log(counts)

console.log('\n--- the phantom upgrade, now provable ---')
const rules = rulesFor(profile)!
const current = inferConfig(profile, (c) => lookupItem(c.item.id)?.weaponType)
console.log('current config:', current, '| allowed:', allowedConfigs(profile, current))
const staff = lookupItem(245770)!.weaponType
const shield = lookupItem(159664)!.weaponType
console.log(`staff=${staff} + shield=${shield}`)
console.log('  as two_hand         ->', isLegalPair('two_hand', staff, shield, rules) ? 'LEGAL' : 'REJECTED')
console.log('  as one_hand_offhand ->', isLegalPair('one_hand_offhand', staff, shield, rules) ? 'LEGAL' : 'REJECTED')
const dagger = lookupItem(273778)!.weaponType
console.log(`dagger=${dagger} + shield=${shield}`)
console.log('  as one_hand_offhand ->', isLegalPair('one_hand_offhand', dagger, shield, rules) ? 'LEGAL' : 'REJECTED')

console.log('\n--- tier set detection ---')
const s = setOf(271483)!
console.log(`${s.name} (id ${s.id}): ${s.items.length} pieces`)
const equippedTier = profile.equipped.filter((c) => setOf(c.item.id)?.id === s.id)
console.log(`equipped pieces of this set: ${equippedTier.length} -> ${equippedTier.length >= 4 ? '4pc' : equippedTier.length >= 2 ? '2pc' : 'no bonus'}`)

console.log('\n--- filterCandidates still sane ---')
console.log('candidates after filters:', filterCandidates(profile).length)
