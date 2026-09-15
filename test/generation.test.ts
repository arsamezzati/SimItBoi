import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Generation, type Output } from '../scripts/lib/generation.ts'

/**
 * Atomic activation of a generated data set.
 *
 * The requirement is that an injected failure at each output stage leaves the
 * prior JSON/SQLite/manifest set intact and usable, so each test
 * here fails the build at a different point and then checks the live files
 * byte-for-byte rather than merely checking they exist.
 *
 * `Generation` resolves outputs relative to the working directory, so each test
 * runs inside its own temporary one.
 */

const OUTPUTS: readonly Output[] = [
  { target: 'data/one.json' },
  { target: 'data/two.json' },
  { target: 'data/store.db' },
  { target: 'assets/icons', merge: true }
]

/** The generation already on disk, which every failure case must preserve. */
const PREVIOUS = {
  'data/one.json': '{"generation":"old","items":[1,2,3]}',
  'data/two.json': '{"generation":"old","items":[4,5,6]}',
  'data/store.db': 'old database bytes'
}

async function workspace(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'simitboi-generation-'))
  const cwd = process.cwd()
  process.chdir(dir)
  t.after(() => { process.chdir(cwd); return rm(dir, { recursive: true, force: true }) })

  for (const [path, body] of Object.entries(PREVIOUS)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), body)
  }
  await mkdir(join(dir, 'assets', 'icons'), { recursive: true })
  await writeFile(join(dir, 'assets', 'icons', 'kept.jpg'), 'an icon an earlier run downloaded')
  return dir
}

/** Asserts the live set is exactly the generation that was there before. */
async function previousIsIntact(): Promise<void> {
  for (const [path, body] of Object.entries(PREVIOUS)) {
    assert.equal(await readFile(path, 'utf8'), body, path + ' was replaced or damaged')
  }
  assert.deepEqual(await readdir(join('assets', 'icons')), ['kept.jpg'])
}

test('a complete generation activates and keeps the one it replaced', async (t) => {
  await workspace(t)
  const generation = await Generation.open(OUTPUTS)
  await writeFile(await generation.pathFor('data/one.json'), '{"generation":"new"}')
  await writeFile(await generation.pathFor('data/two.json'), '{"generation":"new"}')
  await writeFile(await generation.pathFor('data/store.db'), 'new database bytes')
  const icons = await generation.seed('assets/icons')
  await writeFile(join(icons, 'fresh.jpg'), 'a new icon')

  await generation.activate()
  assert.equal(await readFile('data/one.json', 'utf8'), '{"generation":"new"}')
  assert.equal(await readFile('data/store.db', 'utf8'), 'new database bytes')
  // Merged directories accumulate rather than replace.
  assert.deepEqual((await readdir(join('assets', 'icons'))).sort(), ['fresh.jpg', 'kept.jpg'])

  // And the replaced generation is still recoverable.
  await generation.rollback()
  await previousIsIntact()
})

test('a failure before anything is written leaves the previous set', async (t) => {
  await workspace(t)
  const generation = await Generation.open(OUTPUTS)
  await generation.discard()
  await previousIsIntact()
})

test('a failure after the first output leaves the previous set', async (t) => {
  await workspace(t)
  const generation = await Generation.open(OUTPUTS)
  // This is the exact shape of the original bug: season 1 written, then a crash
  // before season 2 exists. Previously that left a mixed generation live.
  await writeFile(await generation.pathFor('data/one.json'), '{"generation":"new"}')
  await generation.discard()
  await previousIsIntact()
})

test('a failure midway through the database leaves the previous one usable', async (t) => {
  await workspace(t)
  const generation = await Generation.open(OUTPUTS)
  await writeFile(await generation.pathFor('data/one.json'), '{"generation":"new"}')
  await writeFile(await generation.pathFor('data/two.json'), '{"generation":"new"}')
  // A half-written database. The old code dropped the live tables first, so the
  // equivalent failure emptied the database the app was using.
  await writeFile(await generation.pathFor('data/store.db'), 'half a data')
  await generation.discard()
  await previousIsIntact()
})

test('an incomplete generation is refused rather than half-activated', async (t) => {
  await workspace(t)
  const generation = await Generation.open(OUTPUTS)
  await writeFile(await generation.pathFor('data/one.json'), '{"generation":"new"}')
  await writeFile(await generation.pathFor('data/two.json'), '{"generation":"new"}')
  // store.db and the icons were never written.

  await assert.rejects(() => generation.activate(), /incomplete and was not activated/)
  await previousIsIntact()
})

test('an empty output counts as missing', async (t) => {
  await workspace(t)
  const generation = await Generation.open(OUTPUTS)
  await writeFile(await generation.pathFor('data/one.json'), '{"generation":"new"}')
  await writeFile(await generation.pathFor('data/two.json'), '{"generation":"new"}')
  // A truncated file is the failure mode that looks fine to anything checking
  // only that a path exists.
  await writeFile(await generation.pathFor('data/store.db'), '')
  await generation.seed('assets/icons')

  await assert.rejects(() => generation.activate(), /store\.db is empty/)
  await previousIsIntact()
})

test('an output the generation does not declare cannot be written', async (t) => {
  await workspace(t)
  const generation = await Generation.open(OUTPUTS)
  await assert.rejects(
    () => generation.pathFor('data/three.json'),
    /is not a declared output/
  )
})

test('staging never touches a live path before activation', async (t) => {
  const dir = await workspace(t)
  const generation = await Generation.open(OUTPUTS)
  await writeFile(await generation.pathFor('data/one.json'), '{"generation":"new"}')
  await writeFile(await generation.pathFor('data/store.db'), 'new database bytes')
  const icons = await generation.seed('assets/icons')
  await writeFile(join(icons, 'fresh.jpg'), 'a new icon')

  // Everything written so far lives under the staging root, not beside the
  // files in use.
  await previousIsIntact()
  const staged = await readdir(join(dir, '.generation'))
  assert.ok(staged.some((name) => name.startsWith('staging-')), 'nothing was staged')
  await generation.discard()
})
