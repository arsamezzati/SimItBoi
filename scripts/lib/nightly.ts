/**
 * Mirroring SimulationCraft nightly builds as CLI-only simc updates.
 *
 * simulationcraft.org publishes Windows builds as a 115 MB .7z holding the Qt
 * GUI and the CLI together, over plain HTTP, with no checksums, and keeps only
 * the newest build per game patch. SimItBoi needs one file from it: simc.exe,
 * 14.8 MB once gzipped. The update workflow turns the former into the latter.
 *
 * Pure decisions live here so they can be tested without GitHub; the workflow
 * script (scripts/simc-update/run.ts) only performs them.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { compareSimcVersions } from '../../src/core/simc/provision.ts'
import { validateManifest, type UpdateBuild, type UpdateManifest } from '../../src/core/simc/update.ts'

export const NIGHTLY_INDEX = 'http://downloads.simulationcraft.org/nightly/'

/** The release whose assets are the signed manifest every install reads. */
export const CHANNEL_TAG = 'simc-channel'

export interface NightlyEntry {
  file: string
  /** simc's banner form, e.g. "1210-01", matching what the binary reports. */
  version: string
  commit: string
}

// Current names: simc-1210.01.c1935b9-win64.7z. Older ones, still documented on
// simulationcraft.org: simc-901-01-win64-7bd7371.7z. Only 64-bit x86 Windows.
const CURRENT = /^simc-([0-9]{3,4})\.([0-9]{2})\.([0-9a-f]{7,40})-win64\.7z$/
const OLDER = /^simc-([0-9]{3,4})-([0-9]{2})-win64-([0-9a-f]{7,40})\.7z$/

/** Windows x64 builds listed in the nightly index page. */
export function parseNightlyIndex(html: string): NightlyEntry[] {
  const entries: NightlyEntry[] = []
  for (const match of html.matchAll(/href="([^"?#]+)"/g)) {
    const file = decodeURIComponent(match[1]!.split('/').pop() ?? '')
    const parsed = CURRENT.exec(file) ?? OLDER.exec(file)
    if (parsed) entries.push({ file, version: parsed[1] + '-' + parsed[2], commit: parsed[3]! })
  }
  return entries
}

/** The newest build by version. Commits within a version cannot be ordered from names, so ties are refused. */
export function pickLatest(entries: readonly NightlyEntry[]): NightlyEntry {
  if (entries.length === 0) throw new Error('The nightly index lists no Windows x64 builds')
  const sorted = [...entries].sort((a, b) => compareSimcVersions(b.version, a.version) ?? 0)
  const [top, next] = sorted
  if (next && compareSimcVersions(top!.version, next.version) === 0 && top!.commit !== next.commit) {
    throw new Error('Two different builds share version ' + top!.version + ' (' + top!.commit + ', ' + next.commit + '); refusing to guess which is newer')
  }
  return top!
}

export function releaseTag(entry: NightlyEntry): string {
  return 'simc-' + entry.version + '-' + entry.commit
}

/**
 * The highest simc version already mirrored or approved, or null if none.
 *
 * Nightlies change every day but simc's version only moves when the simulator
 * does something new (a revision, or a game patch). The workflow compares
 * against this so a new commit under the same version is not proposed.
 */
export function newestKnownVersion(releaseTags: readonly string[], manifest: UpdateManifest): string | null {
  const versions = [
    ...releaseTags.flatMap((tag) => /^simc-([0-9]{3,4}-[0-9]{2})-[0-9a-f]{7,40}$/.exec(tag)?.slice(1, 2) ?? []),
    ...manifest.builds.map((b) => b.version)
  ]
  let newest: string | null = null
  for (const version of versions) {
    if (newest === null || (compareSimcVersions(version, newest) ?? 0) > 0) newest = version
  }
  return newest
}

/** True when the nightly carries a simc version newer than anything known. */
export function isNewVersion(latest: NightlyEntry, known: string | null): boolean {
  return known === null || (compareSimcVersions(latest.version, known) ?? 0) > 0
}

/** What the workflow records about a build when it first mirrors it. */
export interface MirrorRecord {
  version: string
  commit: string
  sourceFile: string
  firstSeen: string
  /** SHA-256 of the .7z as downloaded, for tracing a mirror back to its source. */
  archiveSha256: string
  exeSha256: string
  exeSize: number
  gzSha256: string
  gzSize: number
}

const RECORD_MARK = 'simitboi-simc-mirror'

/** Release notes: readable for people, with the record embedded for the next run. */
export function renderReleaseNotes(record: MirrorRecord): string {
  return [
    'SimulationCraft ' + record.version + ' (commit ' + record.commit + '), command-line simc.exe only.',
    '',
    'Mirrored for SimItBoi from `' + record.sourceFile + '` at ' + NIGHTLY_INDEX + '.',
    'Source code for this exact build: https://github.com/simulationcraft/simc/tree/' + record.commit,
    'SimulationCraft is licensed under the GNU GPL v3; see the attached COPYING file.',
    '',
    'SimItBoi offers it once the update workflow has tested it and added it to the signed manifest',
    'on the simc-channel release.',
    '',
    '<!-- ' + RECORD_MARK + ' ' + JSON.stringify(record) + ' -->',
    ''
  ].join('\n')
}

export function parseReleaseNotes(body: string): MirrorRecord | null {
  const marker = new RegExp('<!-- ' + RECORD_MARK + ' (\\{.*\\}) -->')
  const found = marker.exec(body)
  if (!found) return null
  try {
    return JSON.parse(found[1]!) as MirrorRecord
  } catch {
    return null
  }
}

export type Decision =
  | { action: 'mirror' }
  | { action: 'publish' }
  | { action: 'done'; reason: string }

/**
 * What this run should do about the newest nightly.
 *
 * - Mirrored and already in the published manifest → nothing to do.
 * - Mirrored but not published (an earlier run stopped between the two) →
 *   publish the existing mirror; it is re-verified before signing.
 * - Not mirrored, and simc's version has not moved past everything known →
 *   nothing to do, unless the run asked for any nightly.
 * - Otherwise → mirror it, then publish.
 */
export function decide(options: {
  latest: NightlyEntry
  record: MirrorRecord | null
  manifest: UpdateManifest
  releaseTags: readonly string[]
  anyNightly: boolean
}): Decision {
  const { record, manifest } = options
  if (record) {
    return manifest.builds.some((b) => b.exeSha256 === record.exeSha256)
      ? { action: 'done', reason: 'simc ' + record.version + ' (' + record.commit + ') is already published' }
      : { action: 'publish' }
  }
  const known = newestKnownVersion(options.releaseTags, manifest)
  if (!options.anyNightly && !isNewVersion(options.latest, known)) {
    return { action: 'done', reason: 'simc ' + options.latest.version + ' is not newer than ' + known }
  }
  return { action: 'mirror' }
}

/** Keeps the manifest small: SimItBoi only ever considers the newest entry. */
const MANIFEST_HISTORY = 5

/**
 * Adds a published build at the top of the manifest.
 *
 * Returns text with LF line endings only, so the bytes signed are the bytes
 * uploaded on every platform.
 */
export function addBuildToManifest(manifest: UpdateManifest, build: UpdateBuild): string {
  const builds = [build, ...manifest.builds.filter((b) => b.exeSha256 !== build.exeSha256)]
    .sort((a, b) => compareSimcVersions(b.version, a.version) ?? 0)
    .slice(0, MANIFEST_HISTORY)
  const next: UpdateManifest = { schema: manifest.schema, builds }
  validateManifest(next)
  return JSON.stringify(next, null, 2) + '\n'
}

/** 7-Zip: the one on PATH in CI, or the copy electron-builder installs locally. */
export function sevenZip(): string {
  if (process.env['SEVEN_ZIP']) return process.env['SEVEN_ZIP']
  const bundled = join(process.cwd(), 'node_modules', '7zip-bin', process.platform === 'win32' ? 'win' : process.platform, process.arch, process.platform === 'win32' ? '7za.exe' : '7za')
  return existsSync(bundled) ? bundled : '7z'
}

/**
 * Extracts named files from anywhere inside an archive, flattened into outDir.
 *
 * Only the named files are written — the other 400-odd MB of Qt GUI in the
 * official archive never touches the disk. Throws if any of them is missing.
 */
export function extractFiles(archive: string, names: readonly string[], outDir: string): void {
  execFileSync(sevenZip(), ['e', archive, '-o' + outDir, '-r', '-y', ...names], { stdio: 'pipe' })
  const missing = names.filter((name) => !existsSync(join(outDir, name)))
  if (missing.length > 0) throw new Error(archive + ' does not contain ' + missing.join(', '))
}
