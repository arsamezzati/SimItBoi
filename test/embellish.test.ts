import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import {
  embellishmentCount,
  equipmentRestrictions,
  MAX_EMBELLISHMENTS
} from '../src/core/data/embellish.ts'
import { solveTopGear } from '../src/core/topgear/solver.ts'
import { lookupItem, isCrafted } from '../src/core/data/itemTable.ts'

const profile = (): ReturnType<typeof parseAddonProfile> =>
  parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))

test('the cap is two', () => {
  assert.equal(MAX_EMBELLISHMENTS, 2)
})

test('crafted epics count as embellished', () => {
  const p = profile()
  const faulds = p.equipped.find((c) => c.item.id === 244582)! // crafted epic legs
  const cane = p.equipped.find((c) => c.item.id === 245770)! // crafted epic weapon
  assert.equal(embellishmentCount(faulds), 1)
  assert.equal(embellishmentCount(cane), 1)
})

test('an epic that is not crafted does not count', () => {
  const p = profile()
  const insignia = [...p.equipped, ...p.bagItems].find((c) => c.item.id === 250462)!
  assert.equal(lookupItem(250462)?.quality, 'epic')
  assert.equal(isCrafted(insignia.item), false)
  assert.equal(embellishmentCount(insignia), 0, 'epic alone must not imply embellished')

  const head = p.equipped.find((c) => c.item.id === 271483)! // epic tier, not crafted
  assert.equal(embellishmentCount(head), 0)
})

test('the provider returns a value for every item, never undefined', () => {
  const p = profile()
  for (const c of [...p.equipped, ...p.bagItems]) {
    const r = equipmentRestrictions(c)
    // The solver treats undefined as missing metadata and excludes the item.
    assert.ok(r)
    assert.ok(Number.isSafeInteger(r.embellishments) && r.embellishments >= 0)
    assert.ok(Array.isArray(r.categories))
  }
})

test('the fixture wears exactly two embellishments — at the cap, not over it', () => {
  const p = profile()
  const total = p.equipped.reduce((n, c) => n + embellishmentCount(c), 0)
  assert.equal(total, 2)
  assert.ok(total <= MAX_EMBELLISHMENTS)
})

test('real counts still yield combinations, so the cap does not over-bind', async () => {
  const p = profile()
  const r = await solveTopGear(p, {
    shortlistSize: 3,
    scoreItem: () => 0,
    restrictions: equipmentRestrictions,
    restrictionsAreApproximate: true
  })
  assert.ok(BigInt(r.combinationCount) > 0n, 'the equipped set itself must remain reachable')
})

test('if every item were embellished, no legal set could survive the cap', async () => {
  const p = profile()
  const r = await solveTopGear(p, {
    shortlistSize: 3,
    scoreItem: () => 0,
    restrictions: () => ({ categories: [], embellishments: 3 }),
    restrictionsAreApproximate: true
  })
  // Over-cap items are excluded rather than silently permitted.
  assert.ok(r.excluded.length > 0)
  assert.equal(BigInt(r.combinationCount), 0n)
})

test('approximate restrictions keep the run provisional and say why', async () => {
  const p = profile()
  const r = await solveTopGear(p, {
    shortlistSize: 3,
    scoreItem: () => 0,
    restrictions: equipmentRestrictions,
    restrictionsAreApproximate: true
  })
  assert.equal(r.validation, 'provisional')
  // Embellishments are measured from DB2; what stays approximate is the
  // category membership, whose coverage is limited to current content.
  assert.ok(
    r.warnings.some((w) => /category limits are enforced from bundled membership/i.test(w)),
    `expected an approximation warning, got: ${r.warnings.join(' | ')}`
  )
  assert.ok(
    !r.warnings.some((w) => /inferred from crafted epics/i.test(w)),
    'the retired crafted-epic proxy should no longer be claimed'
  )
})
