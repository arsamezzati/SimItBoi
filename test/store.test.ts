import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store, SCHEMA_VERSION } from '../src/core/store/db.ts'

function store(): Store {
  return new Store(':memory:')
}

test('migrations run once and report the current schema version', () => {
  const s = store()
  assert.equal(s.schemaVersion, SCHEMA_VERSION)
  s.close()
})

test('a report round-trips with its full payload intact', () => {
  const s = store()
  const payload = {
    abilities: [{ name: 'Lava Burst', share: 0.3 }],
    nested: { deep: [1, 2, { x: true }] }
  }
  s.saveReport({
    id: 'r1',
    kind: 'quick',
    createdAt: 1000,
    characterName: 'Vahshandooz',
    className: 'shaman',
    spec: 'elemental',
    dps: 183_958.76,
    simcBuild: '1210-01',
    durationMs: 290,
    payload
  })

  const got = s.getReport<typeof payload>('r1')
  assert.ok(got)
  assert.equal(got.row.characterName, 'Vahshandooz')
  assert.equal(got.row.kind, 'quick')
  // Floating point DPS must survive exactly, not be rounded by the column type.
  assert.equal(got.row.dps, 183_958.76)
  assert.deepEqual(got.payload, payload)
  s.close()
})

test('listing is newest-first and filterable by kind', () => {
  const s = store()
  s.saveReport({ id: 'a', kind: 'quick', createdAt: 100, payload: {} })
  s.saveReport({ id: 'b', kind: 'topgear', createdAt: 300, payload: {} })
  s.saveReport({ id: 'c', kind: 'quick', createdAt: 200, payload: {} })

  assert.deepEqual(s.listReports().map((r) => r.id), ['b', 'c', 'a'])
  assert.deepEqual(s.listReports({ kind: 'quick' }).map((r) => r.id), ['c', 'a'])
  assert.deepEqual(s.listReports({ kind: 'topgear' }).map((r) => r.id), ['b'])
  s.close()
})

test('listing does not load payloads', () => {
  const s = store()
  s.saveReport({ id: 'big', kind: 'quick', payload: { blob: 'x'.repeat(10_000) } })
  const [row] = s.listReports()
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'payload'), false)
  s.close()
})

test('limit and offset page through results', () => {
  const s = store()
  for (let i = 0; i < 10; i++) s.saveReport({ id: `r${i}`, kind: 'quick', createdAt: i, payload: {} })
  assert.deepEqual(s.listReports({ limit: 3 }).map((r) => r.id), ['r9', 'r8', 'r7'])
  assert.deepEqual(s.listReports({ limit: 3, offset: 3 }).map((r) => r.id), ['r6', 'r5', 'r4'])
  s.close()
})

test('saving the same id twice replaces rather than duplicating', () => {
  const s = store()
  s.saveReport({ id: 'dup', kind: 'quick', dps: 1, payload: { v: 1 } })
  s.saveReport({ id: 'dup', kind: 'quick', dps: 2, payload: { v: 2 } })
  assert.equal(s.countReports(), 1)
  assert.equal(s.getReport<{ v: number }>('dup')?.payload.v, 2)
  s.close()
})

test('deleting reports works and reports whether anything was removed', () => {
  const s = store()
  s.saveReport({ id: 'x', kind: 'quick', payload: {} })
  assert.equal(s.deleteReport('x'), true)
  assert.equal(s.deleteReport('x'), false)
  assert.equal(s.getReport('x'), undefined)
  s.close()
})

test('pruning keeps the newest N', () => {
  const s = store()
  for (let i = 0; i < 10; i++) s.saveReport({ id: `r${i}`, kind: 'quick', createdAt: i, payload: {} })
  assert.equal(s.pruneReports(4), 6)
  assert.deepEqual(s.listReports().map((r) => r.id), ['r9', 'r8', 'r7', 'r6'])
  s.close()
})

test('unknown report ids return undefined rather than throwing', () => {
  const s = store()
  assert.equal(s.getReport('nope'), undefined)
  s.close()
})

test('re-pasting an unchanged export updates the profile instead of duplicating', () => {
  const s = store()
  s.saveProfile({ checksum: 'c2e3c9ee', raw: 'shaman="V"', characterName: 'Vahshandooz' })
  const first = s.listProfiles()[0]
  s.saveProfile({ checksum: 'c2e3c9ee', raw: 'shaman="V"', characterName: 'Vahshandooz' })

  assert.equal(s.listProfiles().length, 1)
  const second = s.listProfiles()[0]
  assert.equal(second.firstSeen, first.firstSeen)
  assert.ok(second.lastUsed >= first.lastUsed)
  s.close()
})

test('a changed export is a distinct profile', () => {
  const s = store()
  s.saveProfile({ checksum: 'aaaa', raw: 'v1', characterName: 'V' })
  s.saveProfile({ checksum: 'bbbb', raw: 'v2', characterName: 'V' })
  assert.equal(s.listProfiles().length, 2)
  assert.equal(s.getProfile('aaaa')?.raw, 'v1')
  assert.equal(s.getProfile('bbbb')?.raw, 'v2')
  s.close()
})

test('settings round-trip and overwrite', () => {
  const s = store()
  assert.equal(s.getSetting('theme'), undefined)
  s.setSetting('theme', 'dark')
  assert.equal(s.getSetting('theme'), 'dark')
  s.setSetting('theme', 'light')
  assert.equal(s.getSetting('theme'), 'light')
  s.close()
})

test('reopening the same file keeps the data and does not re-migrate', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'simitboi-store-'))
  const file = join(dir, 'test.db')
  try {
    const a = new Store(file)
    a.saveReport({ id: 'persisted', kind: 'topgear', dps: 184_780, payload: { ok: true } })
    a.close()

    const b = new Store(file)
    assert.equal(b.schemaVersion, SCHEMA_VERSION)
    assert.equal(b.countReports(), 1)
    assert.deepEqual(b.getReport<{ ok: boolean }>('persisted')?.payload, { ok: true })
    b.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
