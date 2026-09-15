import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { coverageFor, tableInfo } from '../src/core/data/itemTable.ts'

test('the bundled table fully covers the reference profile', () => {
  const p = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  const ids = [...p.equipped, ...p.bagItems].map((c) => c.item.id)
  const c = coverageFor(ids)
  assert.equal(c.unknown.length, 0, `unknown ids: ${c.unknown.join(', ')}`)
  assert.equal(c.stale, false)
  assert.equal(c.reason, undefined)
  assert.ok(c.checked > 50)
})

test('an unrecognised id marks the table stale with an actionable reason', () => {
  const c = coverageFor([271483, 999_999_999])
  assert.deepEqual(c.unknown, [999_999_999])
  assert.equal(c.stale, true)
  assert.match(c.reason ?? '', /npm run build:items/)
})

test('table info reports a real version and generation date', () => {
  const i = tableInfo()
  assert.ok(i.version >= 1)
  assert.ok(i.items > 1000)
  assert.ok(!Number.isNaN(Date.parse(i.generated)))
})

test('duplicate ids are counted once', () => {
  const c = coverageFor([271483, 271483, 271483])
  assert.equal(c.checked, 1)
})
