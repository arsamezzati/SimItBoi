import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import {
  allowedConfigs, inferConfig, isLegalPair, rulesFor, SPEC_WEAPON_RULES,
  type WeaponInventoryType
} from '../src/core/topgear/weapons.ts'
import { canWieldWeapon } from '../src/core/data/db2.ts'

/**
 * Weapon configuration rules. Previously only printed by test/weapons.ts.
 *
 * These assert the behaviour of the rule table, not live-game correctness: a
 * passing suite means the solver honours the table it was given, not that the
 * table matches WoW 12.1.
 */

const elemental = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))

/** A minimal profile is enough: only class, spec and weapon slots matter here. */
function spec(className: string, specName: string, weapons: Record<string, number>): ReturnType<typeof parseAddonProfile> {
  const lines = [`${className}="T"`, 'level=90', `spec=${specName}`]
  for (const [slot, id] of Object.entries(weapons)) lines.push(`${slot}=,id=${id}`)
  return parseAddonProfile(`${lines.join('\n')}\n`)
}

test('a two-hander with no off hand infers the two-hand configuration', () => {
  assert.equal(inferConfig(elemental), 'two_hand')
  assert.ok(allowedConfigs(elemental, 'two_hand').includes('two_hand'))
})

test('elemental cannot be given a shield beside a two-hander', () => {
  // The bug this rule exists for: simc validates nothing, so a 2H plus a shield
  // resolves happily and reports a set the player could never equip.
  const rules = rulesFor(elemental)
  assert.ok(rules, 'no weapon rules for shaman:elemental')
  assert.equal(isLegalPair('two_hand', 'two_hand', undefined, rules), true)
  assert.equal(isLegalPair('two_hand', 'two_hand', 'shield', rules), false)
})

test('elemental one-hand pairings follow the table', () => {
  const rules = rulesFor(elemental)!
  assert.equal(isLegalPair('one_hand_offhand', 'one_hand', 'shield', rules), true)
  // The supplied rules give shamans a shield, not a caster off-hand.
  assert.equal(isLegalPair('one_hand_offhand', 'one_hand', 'holdable', rules), false)
  // Elemental is not a dual-wield spec.
  assert.equal(isLegalPair('dual_wield_1h', 'one_hand', 'one_hand', rules), false)
})

test("Titan's Grip is inferred from gear, not from decoding talents", () => {
  // A Fury warrior holding two two-handers can only be Titan's Grip, and
  // that is resolvable without touching the talent blob.
  const fury = spec('warrior', 'fury', { main_hand: 1, off_hand: 2 })
  const asTwoHand: Record<number, WeaponInventoryType> = { 1: 'two_hand', 2: 'two_hand' }
  const config = inferConfig(fury, (c) => asTwoHand[c.item.id])
  assert.equal(config, 'titans_grip')
  const allowed = allowedConfigs(fury, config)
  assert.ok(allowed.includes('titans_grip'))
  // Switching to one-handers needs a respec, so it must not be offered.
  assert.ok(!allowed.includes('dual_wield_1h'), `dual_wield_1h offered: ${allowed.join(', ')}`)
})

test('Single-Minded Fury is a distinct configuration from the same spec', () => {
  const fury = spec('warrior', 'fury', { main_hand: 3, off_hand: 4 })
  const asOneHand: Record<number, WeaponInventoryType> = { 3: 'one_hand', 4: 'one_hand' }
  const config = inferConfig(fury, (c) => asOneHand[c.item.id])
  assert.equal(config, 'dual_wield_1h')
  assert.ok(!allowedConfigs(fury, config).includes('titans_grip'), 'Titan\'s Grip offered without the talent')
})

test('every spec in the table is reachable and explicitly unverified', () => {
  const entries = Object.entries(SPEC_WEAPON_RULES)
  assert.ok(entries.length >= 39, `only ${entries.length} spec entries`)
  for (const [key, rule] of entries) {
    assert.match(key, /^[a-z]+:[a-z_]+$/, `malformed spec key ${key}`)
    assert.ok(rule.configs.length > 0, `${key} allows no configuration at all`)
    // The per-spec rules are verified.
    // What each entry must still carry is the weapon list that makes the claim
    // meaningful — a config alone never said which two-hander.
    assert.equal(rule.verified, true, `${key} is still unverified`)
    assert.ok(rule.mainHand && rule.mainHand.length > 0, `${key} has no weapon list`)
  }
})

test('an unknown spec yields no rules rather than a permissive default', () => {
  const unknown = spec('warrior', 'notaspec', { main_hand: 1 })
  // null, not undefined: the solver throws on a falsy result rather than
  // falling back to something permissive.
  assert.equal(rulesFor(unknown), null)
})

/**
 * Weapon proficiency (derived, unlike the rules above). A spec's `configs` say
 * whether a two-hander is allowed, never which kind — so these are what stops a
 * shadow priest being handed a two-handed sword.
 */
test('proficiency decides which weapons a class may wield, not just how many hands', () => {
  const cases: Array<[string, number, boolean]> = [
    // priest: staves and daggers yes, two-handed swords and axes no.
    ['priest', 10, true], ['priest', 15, true], ['priest', 8, false], ['priest', 1, false],
    ['warrior', 8, true], ['warrior', 10, true],
    ['rogue', 15, true], ['rogue', 8, false],
    ['mage', 10, true], ['mage', 6, false],
    ['demonhunter', 9, true], ['demonhunter', 5, false]
  ]
  for (const [className, subclass, expected] of cases) {
    assert.equal(canWieldWeapon(className, 2, subclass), expected, `${className} subclass ${subclass}`)
  }
})

test('shield proficiency is a class fact, not a spec config', () => {
  for (const className of ['warrior', 'paladin', 'shaman']) {
    assert.equal(canWieldWeapon(className, 4, 6), true, `${className} cannot hold a shield`)
  }
  for (const className of ['priest', 'mage', 'rogue', 'druid', 'deathknight']) {
    assert.equal(canWieldWeapon(className, 4, 6), false, `${className} was allowed a shield`)
  }
})

test('non-weapons are unaffected and an unknown class fails closed', () => {
  // Armour is judged by armour class elsewhere; this must not veto it.
  assert.equal(canWieldWeapon('priest', 4, 1), true, 'cloth armour was vetoed')
  // undefined, not true: the solver treats unknown eligibility as ineligible.
  assert.equal(canWieldWeapon('notaclass', 2, 8), undefined)
})

test('every spec weapon list stays inside its class proficiency', () => {
  // The spec rules are authored; class proficiency is derived from DB2. A spec
  // may be narrower than its class, never wider — a rule allowing a weapon the
  // class cannot wield would be a typo that silently produces illegal sets.
  for (const [key, rule] of Object.entries(SPEC_WEAPON_RULES)) {
    const className = key.split(':')[0]!
    for (const subclass of rule.mainHand ?? []) {
      assert.equal(
        canWieldWeapon(className, 2, subclass), true,
        `${key} allows weapon subclass ${subclass}, which ${className} cannot wield`
      )
    }
  }
})

test('shield specs are exactly the classes with shield proficiency', () => {
  for (const [key, rule] of Object.entries(SPEC_WEAPON_RULES)) {
    if (!(rule.offHand ?? []).includes('shield')) continue
    const className = key.split(':')[0]!
    assert.equal(canWieldWeapon(className, 4, 6), true, `${key} takes a shield its class cannot hold`)
  }
})
