import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DATA_FILES, assertUsableSnapshot, snapshotProblems, validateDataSnapshot
} from '../src/core/data/manifest.ts'

/**
 * Snapshot validation, and the gate it feeds.
 *
 * Validation used to check only that `version` was a number, so six files
 * containing nothing but `{version, gameBuild}` reported no problems while
 * carrying none of the data the app needs. And even when problems were found,
 * nothing acted on them.
 *
 * The damaged cases load a *copy* of the module against gutted data files,
 * because the real module caches its answer and the rest of the suite depends
 * on the shipped snapshot being the one it sees.
 */

/** Loads manifest.ts beside a directory of data files of our choosing. */
async function validateAgainst(
  t: { after: (fn: () => unknown) => void },
  write: (dir: string) => Promise<void>
): Promise<Array<{ file: string; problem: string }>> {
  const dir = await mkdtemp(join(tmpdir(), 'simitboi-snapshot-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp('src/core/data/manifest.ts', join(dir, 'manifest.ts'))
  await write(dir)
  const module = await import(pathToFileURL(join(dir, 'manifest.ts')).href) as {
    validateDataSnapshot: () => Array<{ file: string; problem: string }>
  }
  return module.validateDataSnapshot()
}

test('the shipped snapshot validates and does not block anything', () => {
  assert.deepEqual(validateDataSnapshot(), [])
  assert.deepEqual(snapshotProblems(), [])
  assert.doesNotThrow(() => assertUsableSnapshot())
})

test('problems are computed once, since every run and configure asks', () => {
  assert.equal(snapshotProblems(), snapshotProblems())
})

test('files carrying only a version and build are not a usable snapshot', async (t) => {
  // Files that carry a version and nothing else.
  const problems = await validateAgainst(t, async (dir) => {
    for (const file of DATA_FILES) {
      await writeFile(join(dir, file), JSON.stringify({ version: 999, gameBuild: '12.1.0.69587' }))
    }
  })

  assert.ok(problems.length >= DATA_FILES.length,
    'gutted files produced only ' + problems.length + ' problems')
  // Every file must be named, not just the first one to fail.
  for (const file of DATA_FILES) {
    assert.ok(problems.some((p) => p.file === file), file + ' passed validation while empty')
  }
  // And the reason must distinguish "wrong version" from "no data".
  assert.ok(problems.some((p) => /schema version 999 is not supported/.test(p.problem)))
  assert.ok(problems.some((p) => /is missing or not an array/.test(p.problem)))
})

test('a file of the right version but with no items is still refused', async (t) => {
  const problems = await validateAgainst(t, async (dir) => {
    for (const file of await readdir('src/core/data')) {
      if (file.endsWith('.json')) await cp(join('src/core/data', file), join(dir, file))
    }
    // Correct schema version, correct build, empty payload — the shape a
    // truncated or half-written generation takes.
    await writeFile(join(dir, 'season2-gear.json'), JSON.stringify({
      version: 1, gameBuild: '12.1.0.69587', season: 'Midnight Season 2', items: []
    }))
  })

  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.equal(problems[0].file, 'season2-gear.json')
  assert.match(problems[0].problem, /items holds 0 entries/)
})

test('files describing different game builds are refused', async (t) => {
  const problems = await validateAgainst(t, async (dir) => {
    for (const file of await readdir('src/core/data')) {
      if (file.endsWith('.json')) await cp(join('src/core/data', file), join(dir, file))
    }
    const season = JSON.parse(await import('node:fs').then((fs) =>
      fs.readFileSync('src/core/data/season2-gear.json', 'utf8')))
    // A join between files describing different games is meaningless, however
    // well-formed each file is on its own.
    await writeFile(join(dir, 'season2-gear.json'),
      JSON.stringify({ ...season, gameBuild: '99.9.9.99999' }))
  })

  assert.ok(problems.some((p) => /game build disagreement/.test(p.problem)),
    'mismatched builds were accepted: ' + JSON.stringify(problems))
})
