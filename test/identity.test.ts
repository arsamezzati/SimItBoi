import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { combinedIdentity, dataIdentity, semanticIdentity, type DataFile } from '../src/core/data/manifest.ts'

/**
 * Semantic identity versus artifact checksum.
 *
 * Identity used to hash the whole file including its `generated` timestamp,
 * which both season generators restamp on every run. A rebuild of byte-identical
 * data therefore produced a new identity and told the user every saved selection
 * was stale, when nothing about the items had changed.
 *
 * Each case loads a copy of the module against its own data directory, because
 * the real one caches and the rest of the suite needs the shipped snapshot.
 */

interface Manifest {
  dataIdentity: (file: string) => string
  semanticIdentity: (file: string) => string
  combinedIdentity: (files: readonly string[]) => string
}

/** A private copy of the data directory whose season 2 file the caller edits. */
async function withSeason2(
  t: { after: (fn: () => unknown) => void },
  edit: (parsed: Record<string, unknown>) => Record<string, unknown>
): Promise<Manifest> {
  const dir = await mkdtemp(join(tmpdir(), 'simitboi-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp('src/core/data/manifest.ts', join(dir, 'manifest.ts'))
  for (const file of await readdir('src/core/data')) {
    if (file.endsWith('.json')) await cp(join('src/core/data', file), join(dir, file))
  }
  const parsed = JSON.parse(await readFile('src/core/data/season2-gear.json', 'utf8'))
  await writeFile(join(dir, 'season2-gear.json'), JSON.stringify(edit(parsed), null, 2))
  return await import(pathToFileURL(join(dir, 'manifest.ts')).href) as Manifest
}

const CATALOG: readonly DataFile[] = ['season1-gear.json', 'season2-gear.json']

test('a rebuild that only changes the clock keeps saved selections valid', async (t) => {
  const before = combinedIdentity(CATALOG)
  const after = await withSeason2(t, (parsed) => ({
    ...parsed,
    generated: new Date(Date.now() + 86_400_000).toISOString()
  }))

  assert.equal(after.combinedIdentity(CATALOG), before,
    'a new timestamp invalidated the catalog')
  assert.equal(after.semanticIdentity('season2-gear.json'), semanticIdentity('season2-gear.json'))
  // The artifact checksum *should* move: the bytes genuinely differ, and a
  // report's provenance must record which bytes produced it.
  assert.notEqual(after.dataIdentity('season2-gear.json'), dataIdentity('season2-gear.json'),
    'the artifact checksum ignored a real byte change')
})

test('a changed item does invalidate saved selections', async (t) => {
  const before = combinedIdentity(CATALOG)
  const after = await withSeason2(t, (parsed) => {
    const items = (parsed.items as Array<Record<string, unknown>>).slice()
    items[0] = { ...items[0], baseItemLevel: Number(items[0].baseItemLevel ?? 0) + 1 }
    return { ...parsed, items }
  })

  assert.notEqual(after.combinedIdentity(CATALOG), before,
    'an item level change did not invalidate the catalog')
})

test('a removed item invalidates saved selections', async (t) => {
  const before = combinedIdentity(CATALOG)
  const after = await withSeason2(t, (parsed) => ({
    ...parsed,
    items: (parsed.items as unknown[]).slice(1)
  }))
  assert.notEqual(after.combinedIdentity(CATALOG), before, 'a removed item went unnoticed')
})

test('key order is not content', async (t) => {
  // A generator that builds its object in a different order produces the same
  // data. Without canonical serialization that alone would invalidate every
  // saved selection.
  const before = combinedIdentity(CATALOG)
  const after = await withSeason2(t, (parsed) => {
    const reversed: Record<string, unknown> = {}
    for (const key of Object.keys(parsed).reverse()) reversed[key] = parsed[key]
    return reversed
  })
  assert.equal(after.combinedIdentity(CATALOG), before, 'key order changed the identity')
})

test('the two identities answer different questions', () => {
  // Same file, deliberately different hashes: one describes the bytes, the
  // other what they mean. They used to share one hash.
  assert.notEqual(dataIdentity('season2-gear.json'), semanticIdentity('season2-gear.json'))
  assert.match(semanticIdentity('season2-gear.json'), /^sha256:[0-9a-f]{12}$/)
  // Both are stable within a process.
  assert.equal(semanticIdentity('season2-gear.json'), semanticIdentity('season2-gear.json'))
})
