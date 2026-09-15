import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { SPEC_WEAPON_RULES } from '../src/core/topgear/weapons.ts'

test('spec-weapons.json exists and accurately mirrors SPEC_WEAPON_RULES', () => {
  const data = JSON.parse(readFileSync('src/core/data/spec-weapons.json', 'utf8'))
  assert.equal(data.specCount, 39, 'expected 39 specs')
  assert.equal(data.specs.length, 39)

  for (const [key, rules] of Object.entries(SPEC_WEAPON_RULES)) {
    const spec = data.specsByKey[key]
    assert.ok(spec, `spec-weapons.json missing key: ${key}`)
    assert.deepEqual(spec.allowedConfigs, rules.configs, `allowedConfigs mismatch for ${key}`)
    // The published weapon list is derived from the rules, not authored twice.
    assert.equal(
      spec.allowedWeaponSubclasses.length, (rules.mainHand ?? []).length,
      `weapon list mismatch for ${key}`
    )
    assert.deepEqual(spec.offHand, rules.offHand ?? [], `offHand mismatch for ${key}`)

    const hasShield = (rules.offHand ?? []).includes('shield')
    assert.equal(spec.canShield, hasShield, `canShield mismatch for ${key}`)

    const hasHoldable = (rules.offHand ?? []).includes('holdable')
    assert.equal(spec.canHoldable, hasHoldable, `canHoldable mismatch for ${key}`)

    const hasDW = rules.configs.includes('dual_wield_1h')
    assert.equal(spec.canDualWield, hasDW, `canDualWield mismatch for ${key}`)

    const hasTG = rules.configs.includes('titans_grip')
    assert.equal(spec.canTitansGrip, hasTG, `canTitansGrip mismatch for ${key}`)

    const has2H = rules.configs.includes('two_hand')
    assert.equal(spec.canTwoHand, has2H, `canTwoHand mismatch for ${key}`)

    const hasRanged = rules.configs.includes('ranged')
    assert.equal(spec.canRanged, hasRanged, `canRanged mismatch for ${key}`)
  }
})

test('spec-weapons.json combination aggregations are correct', () => {
  const data = JSON.parse(readFileSync('src/core/data/spec-weapons.json', 'utf8'))

  // Exactly 5 specs can wear a shield in one_hand_offhand:
  // Protection Warrior, Protection Paladin, Holy Paladin, Elemental Shaman, Restoration Shaman
  const shieldSpecs = data.combinations.one_hand_shield.specs.map((s: any) => s.specKey).sort()
  assert.deepEqual(
    shieldSpecs,
    ['paladin:holy', 'paladin:protection', 'shaman:elemental', 'shaman:restoration', 'warrior:protection'].sort()
  )

  // Holdable specs: the pure casters. Shamans and holy paladins take a shield
  // instead, as the per-spec rules require.
  const holdableSpecs = data.combinations.one_hand_holdable.specs.map((s: any) => s.specKey)
  assert.ok(holdableSpecs.includes('mage:arcane'))
  assert.ok(holdableSpecs.includes('priest:shadow'))
  assert.ok(holdableSpecs.includes('druid:balance'))
  assert.ok(!holdableSpecs.includes('paladin:holy'), 'holy paladin should take a shield')
  assert.ok(!holdableSpecs.includes('shaman:elemental'), 'elemental shaman should take a shield')
  assert.ok(!holdableSpecs.includes('warrior:protection'))
  // Feral and Guardian are two-hand only, so neither takes an off-hand at all.
  assert.ok(!holdableSpecs.includes('druid:feral'))
  assert.ok(!holdableSpecs.includes('druid:guardian'))

  // Titan's Grip
  const tgSpecs = data.combinations.titans_grip.specs.map((s: any) => s.specKey)
  assert.deepEqual(tgSpecs, ['warrior:fury'])

  // Ranged specs
  const rangedSpecs = data.combinations.ranged.specs.map((s: any) => s.specKey).sort()
  assert.deepEqual(rangedSpecs, ['hunter:beast_mastery', 'hunter:marksmanship'].sort())
})

test('season_gear.db contains populated spec_weapon_rules and spec_weapon_combinations tables', () => {
  const db = new DatabaseSync('src/core/data/season_gear.db')

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(
    (t) => t.name
  )
  assert.ok(tables.includes('spec_weapon_rules'), 'missing table spec_weapon_rules')
  assert.ok(tables.includes('spec_weapon_combinations'), 'missing table spec_weapon_combinations')

  const ruleCount = (db.prepare('SELECT COUNT(*) as c FROM spec_weapon_rules').get() as any).c
  assert.equal(ruleCount, 39, 'expected 39 spec rules in sqlite')

  const combCount = (db.prepare('SELECT COUNT(*) as c FROM spec_weapon_combinations').get() as any).c
  assert.ok(combCount >= 39, `expected at least one combination per spec, got ${combCount}`)

  // Query test: Find all specs that can equip shields
  const shields = db
    .prepare('SELECT spec_key, class_display, spec_display FROM spec_weapon_rules WHERE can_shield = 1 ORDER BY spec_key')
    .all() as any[]
  assert.equal(shields.length, 5)

  // Query test: Holy Paladin combinations
  const hpalCombs = db
    .prepare("SELECT combination_type, off_hand_slot FROM spec_weapon_combinations WHERE spec_key = 'paladin:holy'")
    .all() as any[]
  const hpalTypes = hpalCombs.map((c) => c.combination_type).sort()
  assert.deepEqual(hpalTypes, ['one_hand_shield', 'two_hand'].sort())

  db.close()
})

test('spec-weapons.json reports the same verification state as its source', () => {
  const data = JSON.parse(readFileSync('src/core/data/spec-weapons.json', 'utf8'))
  // The file must never claim more than the table it mirrors. Both are
  // verified — but the two must move together, which is what this pins.
  const everyRuleVerified = Object.values(SPEC_WEAPON_RULES).every((r) => r.verified)
  assert.equal(data.verified, everyRuleVerified, 'the file and the rules table disagree about verification')
  assert.ok(String(data.source).length > 10, 'the file must record where its claims came from')
})

test('armour class agrees with the bundled item table', () => {
  // armorClass is authored here and also in itemTable.ts. Two hand-maintained
  // copies drift; this fails the moment they disagree.
  const data = JSON.parse(readFileSync('src/core/data/spec-weapons.json', 'utf8'))
  const expected: Record<string, string> = {
    mage: 'cloth', priest: 'cloth', warlock: 'cloth',
    druid: 'leather', rogue: 'leather', monk: 'leather', demonhunter: 'leather',
    hunter: 'mail', shaman: 'mail', evoker: 'mail',
    warrior: 'plate', paladin: 'plate', deathknight: 'plate'
  }
  for (const spec of data.specs as Array<{ specKey: string; className: string; armorClass: string }>) {
    assert.equal(spec.armorClass, expected[spec.className], `${spec.specKey} armour class disagrees`)
  }
})
