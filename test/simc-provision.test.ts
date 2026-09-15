import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activateBuild, buildIdFor, buildsRoot, cleanStaging, compareSimcVersions, ensureProvisioned, exePath,
  listBuilds, pruneBuilds, readActive, readManifest, rollback, stageBuild, verifyBuild
} from '../src/core/simc/provision.ts'

/**
 * Build provisioning.
 *
 * Stand-in files rather than the real 116 MB binary, so these stay fast. The
 * lifecycle against the real executable — including running it out of the
 * provisioned directory — is `npm run check:simc`.
 */

const EXE = 'simc.exe'

async function sandbox(): Promise<{ data: string; source: (body: string) => Promise<string> }> {
  const data = await mkdtemp(join(tmpdir(), 'simitboi-provision-test-'))
  return {
    data,
    /** A directory holding one 'executable' with the given contents. */
    source: async (body: string): Promise<string> => {
      const dir = join(data, 'sources', body.replace(/[^a-z0-9]/gi, '').slice(0, 16))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, EXE), body)
      return dir
    }
  }
}

const bundled = (dir: string, version: string | null = '1210-01') =>
  ({ dir, exe: EXE, version, include: [EXE] as const })

test('a build id changes with the bytes and is readable', () => {
  const a = buildIdFor('1210-01', { 'simc.exe': 'a'.repeat(64) })
  const b = buildIdFor('1210-01', { 'simc.exe': 'b'.repeat(64) })
  assert.notEqual(a, b, 'different contents produced the same build id')
  assert.match(a, /^1210-01-[0-9a-f]{12}$/)
  // Same files in a different insertion order are the same build.
  assert.equal(
    buildIdFor('x', { a: '1', b: '2' }),
    buildIdFor('x', { b: '2', a: '1' })
  )
  // A label is never allowed to make an unusable or invisible directory name:
  // no separators, no traversal, and never a leading dot, which listBuilds
  // skips because that is how staging directories are marked.
  for (const hostile of ['../../etc', 'a/b', 'C:\\x', '...', '   ', '']) {
    const id = buildIdFor(hostile, {})
    assert.doesNotMatch(id, /[/\\]/, hostile + ' produced a path separator')
    assert.ok(!id.startsWith('.'), hostile + ' produced a hidden directory name')
    assert.ok(!id.startsWith('-'), hostile + ' produced a leading dash')
    assert.match(id, /[0-9a-f]{12}$/)
  }
})

test('first launch installs the bundled build and can find its executable', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const result = await ensureProvisioned(data, bundled(await source('simc one')))

  assert.equal(result.installed, true)
  assert.equal(result.manifest.source, 'bundled')
  assert.equal(result.manifest.exe, EXE)
  assert.equal(await readFile(result.exe, 'utf8'), 'simc one')
  assert.deepEqual(await verifyBuild(result.root, result.manifest.buildId), [])
  assert.equal((await readActive(result.root))?.buildId, result.manifest.buildId)
  // Only the named file and its manifest; nothing else is dragged along.
  assert.deepEqual(
    (await readdir(join(result.root, result.manifest.buildId))).sort(),
    ['build.json', EXE]
  )
})

test('a second launch reuses the installed build rather than copying again', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const dir = await source('simc one')
  const first = await ensureProvisioned(data, bundled(dir))
  const second = await ensureProvisioned(data, bundled(dir))
  assert.equal(second.installed, false)
  assert.equal(second.manifest.buildId, first.manifest.buildId)
  assert.equal((await listBuilds(first.root)).length, 1)
})

test('a damaged active build is repaired from the bundled copy', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const dir = await source('simc one')
  const first = await ensureProvisioned(data, bundled(dir))
  await writeFile(first.exe, 'corrupted')

  assert.equal((await verifyBuild(first.root, first.manifest.buildId)).length, 1)
  const repaired = await ensureProvisioned(data, bundled(dir))
  assert.equal(repaired.installed, true, 'a corrupted build was accepted')
  assert.deepEqual(await verifyBuild(repaired.root, repaired.manifest.buildId), [])
  assert.equal(await readFile(repaired.exe, 'utf8'), 'simc one')
})

test('a build is never installed over one that is already there', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const first = await ensureProvisioned(data, bundled(await source('simc one')))
  const staged = await stageBuild(first.root, {
    ...bundled(await source('simc two'), '1211-01'), source: 'test'
  })

  assert.notEqual(staged.manifest.buildId, first.manifest.buildId)
  // The build in use is byte-for-byte untouched.
  assert.equal(await readFile(first.exe, 'utf8'), 'simc one')
  assert.deepEqual(await verifyBuild(first.root, first.manifest.buildId), [])
  // And it is still the active one: staging does not activate.
  assert.equal((await readActive(first.root))?.buildId, first.manifest.buildId)
})

test('activation verifies first, so a broken build never becomes active', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const first = await ensureProvisioned(data, bundled(await source('simc one')))
  const staged = await stageBuild(first.root, {
    ...bundled(await source('simc two'), '1211-01'), source: 'test'
  })
  await writeFile(join(first.root, staged.manifest.buildId, EXE), 'corrupted')

  await assert.rejects(
    () => activateBuild(first.root, staged.manifest.buildId),
    /does not match its checksum/
  )
  assert.equal((await readActive(first.root))?.buildId, first.manifest.buildId,
    'a failed activation changed which build is active')
})

test('rollback returns to the build that was replaced', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const first = await ensureProvisioned(data, bundled(await source('simc one')))
  const staged = await stageBuild(first.root, {
    ...bundled(await source('simc two'), '1211-01'), source: 'test'
  })

  await activateBuild(first.root, staged.manifest.buildId)
  assert.equal((await readActive(first.root))?.previousBuildId, first.manifest.buildId)
  const back = await rollback(first.root)
  assert.equal(back.buildId, first.manifest.buildId)
  assert.equal(await readFile(exePath(first.root, back), 'utf8'), 'simc one')
})

test('there is nothing to roll back to before a second build exists', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const first = await ensureProvisioned(data, bundled(await source('simc one')))
  await assert.rejects(() => rollback(first.root), /no previous simc build/)
})

test('retention keeps the active build and its rollback target', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const first = await ensureProvisioned(data, bundled(await source('simc one')))
  const second = await stageBuild(first.root, { ...bundled(await source('simc two'), '2'), source: 'test' })
  await activateBuild(first.root, second.manifest.buildId)
  for (const tag of ['3', '4', '5']) {
    await stageBuild(first.root, { ...bundled(await source('simc ' + tag), tag), source: 'test' })
  }

  assert.equal((await listBuilds(first.root)).length, 5)
  const removed = await pruneBuilds(first.root, { keep: 1 })
  assert.ok(removed.length > 0, 'retention removed nothing')
  assert.ok(!removed.includes(second.manifest.buildId), 'retention removed the active build')
  assert.ok(!removed.includes(first.manifest.buildId), 'retention removed the rollback target')
  // Both survivors are still intact, not merely still listed.
  for (const id of [first.manifest.buildId, second.manifest.buildId]) {
    assert.deepEqual(await verifyBuild(first.root, id), [])
  }
})

test('a pinned build survives retention even when it is not active', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const first = await ensureProvisioned(data, bundled(await source('simc one')))
  const pinned = await stageBuild(first.root, { ...bundled(await source('simc two'), '2'), source: 'test' })
  const third = await stageBuild(first.root, { ...bundled(await source('simc three'), '3'), source: 'test' })
  const fourth = await stageBuild(first.root, { ...bundled(await source('simc four'), '4'), source: 'test' })
  void third
  void fourth

  // A run in flight is executing this binary; retention must not delete it.
  const removed = await pruneBuilds(first.root, { keep: 1, protect: [pinned.manifest.buildId] })
  assert.ok(removed.length > 0)
  assert.ok(!removed.includes(pinned.manifest.buildId), 'retention deleted a build a run had pinned')
  assert.deepEqual(await verifyBuild(first.root, pinned.manifest.buildId), [])
})

test('an interrupted provision leaves nothing that looks like a build', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const dir = await source('simc one')
  const root = buildsRoot(data)
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(() => stageBuild(root, { ...bundled(dir), source: 'test' }, controller.signal))
  assert.deepEqual(await listBuilds(root), [], 'an aborted stage left a build behind')

  // A staging directory from a crash is cleaned up rather than mistaken for one.
  await mkdir(join(root, '.staging-leftover'), { recursive: true })
  await writeFile(join(root, '.staging-leftover', EXE), 'partial')
  assert.equal(await cleanStaging(root), 1)
  assert.deepEqual(await listBuilds(root), [])
})

test('a manifest from a future schema is not usable', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const first = await ensureProvisioned(data, bundled(await source('simc one')))
  const manifest = await readManifest(first.root, first.manifest.buildId)
  await writeFile(
    join(first.root, first.manifest.buildId, 'build.json'),
    JSON.stringify({ ...manifest, schema: 99 })
  )

  const problems = await verifyBuild(first.root, first.manifest.buildId)
  assert.equal(problems.length, 1)
  assert.match(problems[0].problem, /unsupported manifest schema 99/)
  await assert.rejects(() => activateBuild(first.root, first.manifest.buildId), /unsupported manifest schema/)
})

test('a missing bundled build fails loudly rather than silently', async (t) => {
  const { data } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  await assert.rejects(
    () => ensureProvisioned(data, bundled(join(data, 'nowhere'))),
    /ENOENT/
  )
})

// Upgrading through a new release. ensureProvisioned used to return any intact
// active build immediately, so unzipping a release with a newer simc over an old
// folder kept the old simulator — and the next WoW patch's /simc export was then
// refused by the version gate while the right binary sat unused in the download.

test('simc build versions order by patch, then revision', () => {
  assert.ok(compareSimcVersions('1210-02', '1210-01')! > 0)
  assert.ok(compareSimcVersions('1215-01', '1210-09')! > 0)
  assert.ok(compareSimcVersions('1205-03', '1210-01')! < 0)
  assert.equal(compareSimcVersions('1210-01', '1210-01'), 0)
  // Unreadable versions are never guessed at.
  assert.equal(compareSimcVersions(null, '1210-01'), null)
  assert.equal(compareSimcVersions('nightly', '1210-01'), null)
})

test('a new release with a newer bundled simc upgrades an existing install', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const old = await ensureProvisioned(data, bundled(await source('simc one'), '1210-01'))

  // The user unzips a newer SimItBoi over the same folder.
  const upgraded = await ensureProvisioned(data, bundled(await source('simc two'), '1215-01'))
  assert.notEqual(upgraded.manifest.buildId, old.manifest.buildId, 'the old simulator was kept')
  assert.equal(upgraded.upgradedFrom, old.manifest.buildId)
  assert.equal(await readFile(upgraded.exe, 'utf8'), 'simc two')
  // The replaced build is the rollback target, still intact.
  assert.equal((await readActive(upgraded.root))?.previousBuildId, old.manifest.buildId)
  assert.deepEqual(await verifyBuild(upgraded.root, old.manifest.buildId), [])
})

test('a same-version rebuild shipped by the app replaces the one it shipped before', async (t) => {
  // simc nightlies keep one version string across a patch, so bytes decide.
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const old = await ensureProvisioned(data, bundled(await source('nightly a'), '1210-01'))
  const next = await ensureProvisioned(data, bundled(await source('nightly b'), '1210-01'))
  assert.notEqual(next.manifest.buildId, old.manifest.buildId)
  assert.equal(await readFile(next.exe, 'utf8'), 'nightly b')
})

test('an older release never downgrades the simulator', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const newer = await ensureProvisioned(data, bundled(await source('simc new'), '1215-01'))
  const again = await ensureProvisioned(data, bundled(await source('simc old'), '1210-01'))
  assert.equal(again.manifest.buildId, newer.manifest.buildId, 'an older bundled build downgraded simc')
  assert.equal(again.upgradedFrom, null)
})

test('a rollback is not undone on the next launch', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const oldDir = await source('simc one')
  const newDir = await source('simc two')
  const old = await ensureProvisioned(data, bundled(oldDir, '1210-01'))
  await ensureProvisioned(data, bundled(newDir, '1215-01'))
  await rollback(old.root)

  // Relaunching the same release must respect the user's rollback, even though
  // its bundled build is newer than what is now active.
  const relaunch = await ensureProvisioned(data, bundled(newDir, '1215-01'))
  assert.equal(relaunch.manifest.buildId, old.manifest.buildId, 'the rollback was reverted on launch')
})

test('a build someone chose is replaced only by a strictly newer one', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const first = await ensureProvisioned(data, bundled(await source('simc one'), '1210-01'))
  const chosen = await stageBuild(first.root, { ...bundled(await source('downloaded'), '1212-01'), source: 'https://example.invalid/simc' })
  await activateBuild(first.root, chosen.manifest.buildId)

  const sameVersion = await ensureProvisioned(data, bundled(await source('bundled same'), '1212-01'))
  assert.equal(sameVersion.manifest.buildId, chosen.manifest.buildId, 'a deliberate choice was replaced by a same-version build')

  const newer = await ensureProvisioned(data, bundled(await source('bundled newer'), '1213-01'))
  assert.notEqual(newer.manifest.buildId, chosen.manifest.buildId, 'a strictly newer bundled build did not take over')
})

test('an unknown bundled version does not replace a known one', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const known = await ensureProvisioned(data, bundled(await source('simc one'), '1210-01'))
  const unknown = await ensureProvisioned(data, bundled(await source('simc mystery'), null))
  assert.equal(unknown.manifest.buildId, known.manifest.buildId)
})

test('rollback to a build that is no longer installed says there is nothing to go back to', async (t) => {
  const { data, source } = await sandbox()
  t.after(() => rm(data, { recursive: true, force: true }))
  const first = await ensureProvisioned(data, bundled(await source('simc one'), '1210-01'))
  await ensureProvisioned(data, bundled(await source('simc two'), '1215-01'))
  // Retention or a hand-deleted folder can remove the build the record names.
  await rm(join(first.root, first.manifest.buildId), { recursive: true, force: true })
  await assert.rejects(() => rollback(first.root), /no previous simc build to roll back to/)
})
