import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addBuildToManifest, decide, extractFiles, isNewVersion, newestKnownVersion, parseNightlyIndex, parseReleaseNotes, pickLatest,
  releaseTag, renderReleaseNotes, sevenZip, type MirrorRecord
} from '../scripts/lib/nightly.ts'
import type { UpdateBuild, UpdateManifest } from '../src/core/simc/update.ts'

/**
 * The update workflow's decisions, tested without GitHub or the network.
 *
 * The index below is shaped like the real simulationcraft.org nightly listing
 * as fetched on 2026-09-15, including the macOS and Windows-on-ARM files that
 * must be ignored.
 */

const INDEX = `<html><body><h1>Index of /nightly</h1><table>
<tr><td><a href="/">Parent Directory</a></td></tr>
<tr><td><a href="simc-1210-01-macos-c1935b9.dmg">simc-1210-01-macos-c1935b9.dmg</a></td></tr>
<tr><td><a href="simc-1210.01.c1935b9-winarm64.7z">simc-1210.01.c1935b9-winarm64.7z</a></td></tr>
<tr><td><a href="simc-1210.01.c1935b9-win64.7z">simc-1210.01.c1935b9-win64.7z</a></td></tr>
<tr><td><a href="simc-1205.01.ac79c0f-win64.7z">simc-1205.01.ac79c0f-win64.7z</a></td></tr>
<tr><td><a href="simc-901-01-win64-7bd7371.7z">simc-901-01-win64-7bd7371.7z</a></td></tr>
<tr><td><a href="?C=M;O=A">Last modified</a></td></tr>
</table></body></html>`

test('the nightly index yields only Windows x64 builds, in both name formats', () => {
  const entries = parseNightlyIndex(INDEX)
  assert.deepEqual(entries.map((e) => e.file), [
    'simc-1210.01.c1935b9-win64.7z', 'simc-1205.01.ac79c0f-win64.7z', 'simc-901-01-win64-7bd7371.7z'
  ])
  assert.deepEqual(entries[0], { file: 'simc-1210.01.c1935b9-win64.7z', version: '1210-01', commit: 'c1935b9' })
  // The version is written the way simc.exe reports it, so the post-install
  // version check compares like with like.
  assert.equal(entries[2]!.version, '901-01')
})

test('the newest build is chosen by version, and an ambiguous tie is refused', () => {
  const entries = parseNightlyIndex(INDEX)
  assert.equal(pickLatest(entries).commit, 'c1935b9')
  assert.equal(releaseTag(pickLatest(entries)), 'simc-1210-01-c1935b9')

  assert.throws(() => pickLatest([]), /no Windows x64 builds/)
  assert.throws(
    () => pickLatest([
      { file: 'a', version: '1210-01', commit: 'aaaaaaa' },
      { file: 'b', version: '1210-01', commit: 'bbbbbbb' }
    ]),
    /refusing to guess/
  )
})

const RECORD: MirrorRecord = {
  version: '1210-01', commit: 'c1935b9', sourceFile: 'simc-1210.01.c1935b9-win64.7z',
  firstSeen: '2026-09-01T06:17:00Z', archiveSha256: 'a'.repeat(64),
  exeSha256: 'b'.repeat(64), exeSize: 121016832, gzSha256: 'c'.repeat(64), gzSize: 15507000
}
const EMPTY: UpdateManifest = { schema: 1, builds: [] }

test('release notes carry the record through a round trip, with the GPL obligations stated', () => {
  const notes = renderReleaseNotes(RECORD)
  assert.deepEqual(parseReleaseNotes(notes), RECORD)
  assert.match(notes, /github\.com\/simulationcraft\/simc\/tree\/c1935b9/)
  assert.match(notes, /GNU GPL v3/)
  assert.equal(parseReleaseNotes('a release someone edited by hand'), null)
})

test('the workflow mirrors, waits, promotes, and stops on changed bytes', () => {
  const base = { archiveSha256: RECORD.archiveSha256, manifest: EMPTY, pullRequestOpen: false, minAgeDays: 7 }
  const day = (iso: string) => new Date(iso)

  assert.deepEqual(decide({ ...base, record: null, now: day('2026-09-01T06:17:00Z') }), { action: 'mirror' })
  assert.deepEqual(decide({ ...base, record: RECORD, now: day('2026-09-03T06:17:00Z') }), { action: 'wait', daysLeft: 5 })
  assert.deepEqual(decide({ ...base, record: RECORD, now: day('2026-09-08T06:17:00Z') }), { action: 'promote' })

  // The same file name now holds different bytes: someone needs to look.
  const tampered = decide({ ...base, archiveSha256: 'd'.repeat(64), record: RECORD, now: day('2026-09-08T06:17:00Z') })
  assert.equal(tampered.action, 'tampered')

  assert.equal(decide({ ...base, pullRequestOpen: true, record: RECORD, now: day('2026-09-09T00:00:00Z') }).action, 'done')
  const approved: UpdateManifest = { schema: 1, builds: [buildFrom(RECORD)] }
  assert.equal(decide({ ...base, manifest: approved, record: RECORD, now: day('2026-09-20T00:00:00Z') }).action, 'done')
})

function buildFrom(record: MirrorRecord, version = record.version): UpdateBuild {
  return {
    version, commit: record.commit,
    url: 'https://github.com/arsamezzati/SimItBoi/releases/download/simc-' + version + '-' + record.commit + '/simc.exe.gz',
    gzSha256: record.gzSha256, gzSize: record.gzSize, exeSha256: record.exeSha256, exeSize: record.exeSize,
    publishedAt: '2026-09-08T06:17:00Z'
  }
}

test('approving a build puts it first, drops duplicates, caps history, and writes LF only', () => {
  let text = addBuildToManifest(EMPTY, buildFrom(RECORD))
  assert.ok(!text.includes('\r'), 'the manifest contains CR bytes, which would break its signature')
  assert.ok(text.endsWith('\n'))

  for (let i = 2; i <= 8; i++) {
    const record = { ...RECORD, exeSha256: String(i).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'e'), commit: 'c19' + i + 'b9a' }
    text = addBuildToManifest(JSON.parse(text) as UpdateManifest, buildFrom(record, '1210-0' + i))
  }
  const manifest = JSON.parse(text) as UpdateManifest
  assert.equal(manifest.builds.length, 5, 'history was not capped')
  assert.equal(manifest.builds[0]!.version, '1210-08', 'the newest build is not first')

  // Re-approving an existing build does not duplicate it.
  const again = JSON.parse(addBuildToManifest(manifest, manifest.builds[2]!)) as UpdateManifest
  assert.equal(again.builds.filter((b) => b.exeSha256 === manifest.builds[2]!.exeSha256).length, 1)
})

test('only simc.exe and its license are extracted, from wherever they sit in the archive', { skip: !existsSync(sevenZip()) && sevenZip() !== '7z' }, async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'simitboi-extract-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  // Shaped like the official archive: a top folder, the CLI, the license, and
  // a GUI we must not unpack.
  const tree = join(work, 'tree', 'simc-1210.01-win64')
  await mkdir(join(tree, 'qml'), { recursive: true })
  await writeFile(join(tree, 'simc.exe'), 'the command-line simulator')
  await writeFile(join(tree, 'COPYING'), 'GNU GENERAL PUBLIC LICENSE Version 3')
  await writeFile(join(tree, 'SimulationCraft.exe'), 'the GUI, not wanted')
  await writeFile(join(tree, 'qml', 'huge.dll'), 'not wanted either')
  const archive = join(work, 'simc.7z')
  execFileSync(sevenZip(), ['a', archive, join(work, 'tree', '*')], { stdio: 'pipe' })

  const out = join(work, 'out')
  extractFiles(archive, ['simc.exe', 'COPYING'], out)
  assert.deepEqual((await readdir(out)).sort(), ['COPYING', 'simc.exe'])
  assert.equal(await readFile(join(out, 'simc.exe'), 'utf8'), 'the command-line simulator')

  assert.throws(() => extractFiles(archive, ['simc.exe', 'missing.txt'], join(work, 'out2')), /does not contain missing\.txt/)
})

test('only a newer simc version is new; another commit under the same version is not', () => {
  const tags = ['simc-1210-01-c1935b9', 'simc-1205-01-ac79c0f', 'v0.1.0']
  assert.equal(newestKnownVersion(tags, EMPTY), '1210-01')
  assert.equal(newestKnownVersion([], EMPTY), null)
  // An approved build counts even if its release was deleted.
  assert.equal(newestKnownVersion(tags, { schema: 1, builds: [buildFrom(RECORD, '1210-02')] }), '1210-02')

  const entry = (version: string, commit: string) => ({ file: 'x', version, commit })
  assert.equal(isNewVersion(entry('1210-01', 'fffffff'), '1210-01'), false)
  assert.equal(isNewVersion(entry('1205-02', 'fffffff'), '1210-01'), false)
  assert.equal(isNewVersion(entry('1210-02', 'fffffff'), '1210-01'), true)
  assert.equal(isNewVersion(entry('1215-01', 'fffffff'), '1210-02'), true)
  // Nothing mirrored yet: the first run takes whatever is newest.
  assert.equal(isNewVersion(entry('1210-01', 'c1935b9'), null), true)
})

test('with no waiting period a mirrored build is proposed at once', () => {
  const decision = decide({
    record: RECORD, archiveSha256: RECORD.archiveSha256, manifest: EMPTY,
    pullRequestOpen: false, minAgeDays: 0, now: new Date(RECORD.firstSeen)
  })
  assert.deepEqual(decision, { action: 'promote' })
})
