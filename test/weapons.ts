import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { inferConfig, allowedConfigs, rulesFor, isLegalPair, SPEC_WEAPON_RULES,
         type WeaponInventoryType } from '../src/core/topgear/weapons.ts'

const profile = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
console.log('spec:', `${profile.className}:${profile.spec}`)
console.log('rules:', JSON.stringify(rulesFor(profile)))
const current = inferConfig(profile)
console.log('inferred current config:', current, '(no off hand equipped -> 2H)')
console.log('allowed configs:', allowedConfigs(profile, current))

console.log('\n--- Titan\'s Grip: the case that breaks naive rules ---')
const fury = parseAddonProfile('warrior="F"\nlevel=90\nspec=fury\nmain_hand=,id=1\noff_hand=,id=2\n')
const types: Record<number, WeaponInventoryType> = { 1: 'two_hand', 2: 'two_hand' }
const tgConfig = inferConfig(fury, (c) => types[c.item.id])
console.log('Fury wearing 2H + 2H ->', tgConfig)
console.log('allowed:', allowedConfigs(fury, tgConfig), ' (dual_wield_1h correctly excluded — needs a respec)')

const smf = parseAddonProfile('warrior="F"\nlevel=90\nspec=fury\nmain_hand=,id=3\noff_hand=,id=4\n')
const smfTypes: Record<number, WeaponInventoryType> = { 3: 'one_hand', 4: 'one_hand' }
const smfConfig = inferConfig(smf, (c) => smfTypes[c.item.id])
console.log('Fury wearing 1H + 1H ->', smfConfig)
console.log('allowed:', allowedConfigs(smf, smfConfig))

console.log('\n--- pair legality ---')
const ele = rulesFor(profile)!
const cases: Array<[string, Parameters<typeof isLegalPair>[0], WeaponInventoryType | undefined, WeaponInventoryType | undefined]> = [
  ['ele: 2H alone',            'two_hand',         'two_hand', undefined],
  ['ele: 2H + shield (THE BUG)','two_hand',        'two_hand', 'shield'],
  ['ele: 1H + shield',         'one_hand_offhand', 'one_hand', 'shield'],
  ['ele: 1H + holdable',       'one_hand_offhand', 'one_hand', 'holdable'],
  ['ele: 1H + 1H',             'dual_wield_1h',    'one_hand', 'one_hand']
]
for (const [label, cfg, mh, oh] of cases) {
  console.log(`  ${label.padEnd(30)} -> ${isLegalPair(cfg, mh, oh, ele) ? 'LEGAL' : 'rejected'}`)
}
const unverified = Object.values(SPEC_WEAPON_RULES).filter((r) => !r.verified).length
console.log(`\nspecs in table: ${Object.keys(SPEC_WEAPON_RULES).length}, unverified: ${unverified}`)
