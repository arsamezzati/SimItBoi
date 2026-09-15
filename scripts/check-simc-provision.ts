/**
 * simc provisioning lifecycle against the real binary.
 *
 * The unit tests use small stand-in files so they stay fast. This one uses the
 * actual 116 MB simc.exe and then *runs* it out of the provisioned directory,
 * because the thing being claimed is "a packaged app can sim on first launch",
 * and nothing short of executing the provisioned copy demonstrates that.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activateBuild, buildsRoot, ensureProvisioned, listBuilds, pruneBuilds,
  readActive, rollback, stageBuild, verifyBuild
} from '../src/core/simc/provision.ts'
import { probeVersion, runSim } from '../src/core/simc/runner.ts'
import { extractReport } from '../src/core/report/extract.ts'

const VENDOR = join(process.cwd(), 'vendor', 'simc')
const EXE = 'simc.exe'

await stat(join(VENDOR, EXE)).catch(() => {
  throw new Error('vendor/simc/simc.exe is required: download SimulationCraft and copy simc.exe there')
})

const data = await mkdtemp(join(tmpdir(), 'simitboi-provision-'))
try {
  // First launch: nothing on disk, the bundled build gets installed and activated.
  const first = await ensureProvisioned(data, { dir: VENDOR, exe: EXE, version: null, include: [EXE] })
  assert.equal(first.installed, true, 'the bundled build should have been installed')
  assert.equal(first.manifest.source, 'bundled')
  const root = buildsRoot(data)
  assert.deepEqual(await verifyBuild(root, first.manifest.buildId), [])
  console.log('provisioned', first.manifest.buildId)

  // Only the executable was copied, not the 423 MB of Qt beside it.
  const contents = (await readdir(join(root, first.manifest.buildId))).sort()
  assert.deepEqual(contents, ['build.json', EXE], `unexpected build contents: ${contents.join(', ')}`)

  // The provisioned copy must actually simulate. This is the claim that matters.
  const version = await probeVersion(first.exe)
  assert.ok(version, 'the provisioned binary did not report a version')
  const profile = await readFile('fixtures/vahshandooz-elemental.simc', 'utf8')
  const settings = ['iterations=50', 'threads=2', ''].join(String.fromCharCode(10))
  const run = await runSim({ simcPath: first.exe, input: profile + String.fromCharCode(10) + settings })
  const report = extractReport(run.json)
  assert.ok(report && report.dps.mean > 0, 'the provisioned binary produced no DPS')
  console.log('ran from the provisioned copy: ' + Math.round(report.dps.mean).toLocaleString() + ' dps')

  // Second launch: the same build is reused, not copied again.
  const second = await ensureProvisioned(data, { dir: VENDOR, exe: EXE, version: null, include: [EXE] })
  assert.equal(second.installed, false, 'an intact build was reinstalled instead of reused')
  assert.equal(second.manifest.buildId, first.manifest.buildId)

  // A second, different build provisions beside the first rather than over it.
  const other = await mkdtemp(join(tmpdir(), 'simitboi-other-'))
  await writeFile(join(other, EXE), 'not really simc, but a distinct build\n')
  const staged = await stageBuild(root, { dir: other, exe: EXE, version: '9999-99', source: 'test', include: [EXE] })
  assert.notEqual(staged.manifest.buildId, first.manifest.buildId)
  assert.deepEqual(await verifyBuild(root, first.manifest.buildId), [], 'the existing build was disturbed')

  // Activation switches, and records what to roll back to.
  await activateBuild(root, staged.manifest.buildId)
  assert.equal((await readActive(root))?.buildId, staged.manifest.buildId)
  assert.equal((await readActive(root))?.previousBuildId, first.manifest.buildId)
  const back = await rollback(root)
  assert.equal(back.buildId, first.manifest.buildId, 'rollback did not return to the bundled build')
  console.log('activate and rollback hold')

  // A damaged build is refused rather than activated, so the app is never
  // pointed at something it cannot run.
  await writeFile(join(root, staged.manifest.buildId, EXE), 'corrupted\n')
  const problems = await verifyBuild(root, staged.manifest.buildId)
  assert.equal(problems.length, 1)
  assert.match(problems[0].problem, /does not match its checksum/)
  await assert.rejects(() => activateBuild(root, staged.manifest.buildId), /does not match its checksum/)
  assert.equal((await readActive(root))?.buildId, first.manifest.buildId, 'a failed activation changed the active build')
  console.log('a damaged build cannot be activated')

  // ensureProvisioned falls back to an intact build rather than reinstalling.
  const third = await ensureProvisioned(data, { dir: VENDOR, exe: EXE, version: null, include: [EXE] })
  assert.equal(third.manifest.buildId, first.manifest.buildId)
  assert.equal(third.installed, false)

  // Retention has to actually remove something, and never the builds that
  // matter. Two more throwaway builds go in so there is something prunable at
  // all: with only the active build and its predecessor, both are protected and
  // a passing prune would prove nothing.
  for (const tag of ['8888-88', '7777-77']) {
    const spare = await mkdtemp(join(tmpdir(), 'simitboi-spare-'))
    await writeFile(join(spare, EXE), 'spare build ' + tag + String.fromCharCode(10))
    await stageBuild(root, { dir: spare, exe: EXE, version: tag, source: 'test', include: [EXE] })
    await rm(spare, { recursive: true, force: true })
  }
  const before = await listBuilds(root)
  assert.ok(before.length >= 4, 'expected several builds before pruning, got ' + before.length)
  const active = await readActive(root)
  const removed = await pruneBuilds(root, { keep: 1 })
  const after = await listBuilds(root)
  assert.ok(removed.length > 0, 'retention removed nothing despite spare builds')
  assert.ok(after.length < before.length, 'retention kept every build')
  assert.ok(!removed.includes(active!.buildId), 'retention removed the active build')
  assert.ok(!removed.includes(active!.previousBuildId ?? ''), 'retention removed the rollback target')
  assert.ok(after.some((b) => b.buildId === first.manifest.buildId), 'retention deleted the active build')
  assert.deepEqual(await verifyBuild(root, first.manifest.buildId), [], 'the active build was damaged by retention')
  console.log('retention removed ' + removed.length + ' of ' + before.length + ' builds, keeping the active one and its rollback target')

  await rm(other, { recursive: true, force: true })
  console.log('\nAll simc provisioning checks passed.')
} finally {
  await rm(data, { recursive: true, force: true })
}
