/**
 * simc build provisioning.
 *
 * The app ships a known-good simulator so launch #1 can sim with no download
 * gate. Builds live side by side under `<data>/simc/<buildId>/` and one of them
 * is active; nothing ever writes into a build directory after it is created.
 *
 * The rules this enforces, all of which exist because the alternative corrupts
 * a working install:
 *
 * - A build is staged into a temporary directory, verified there, and only then
 *   moved into place under its real name. A half-copied build never occupies a
 *   name that something might run.
 * - Activation verifies before it switches. An unusable build cannot become the
 *   active one, so there is no state where the app points at something broken.
 * - The active build and the one it replaced are never pruned, so rollback
 *   always has somewhere to go.
 * - Callers pin a build for the length of their work. Activation changes what
 *   the *next* run uses, never what a running one is already executing.
 *
 * Downloading is deliberately not part of this. `stageBuild` takes a directory
 * that already exists, so the bundled copy and a future downloader are the same
 * operation with a different source; see update.ts.
 */
import { createHash } from 'node:crypto'
import {
  copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { sha256File } from './identity.ts'

/** Bumped when the on-disk shape changes; an unknown schema is not usable. */
export const MANIFEST_SCHEMA = 1
const MANIFEST = 'build.json'
const ACTIVE = 'active.json'
const STAGING_PREFIX = '.staging-'

export interface BuildManifest {
  schema: number
  /** Directory name, and the id every other call takes. */
  buildId: string
  /** simc's own version string when it could be probed, else null. */
  version: string | null
  /** Executable file name inside the build directory. */
  exe: string
  /** Every file in the build, by name, with its sha256. */
  files: Record<string, string>
  /** Where this build came from: "bundled", or a URL for a downloaded one. */
  source: string
  provisionedAt: string
}

export interface ActiveRecord {
  schema: number
  buildId: string
  /** What to roll back to. Null when this is the first build provisioned. */
  previousBuildId: string | null
  activatedAt: string
}

export interface BuildProblem {
  buildId: string
  problem: string
}

/** Where builds live under a data directory. */
export function buildsRoot(dataDir: string): string {
  return join(dataDir, 'simc')
}

/** The executable to spawn for a build. Callers pin this, not the build id. */
export function exePath(root: string, manifest: BuildManifest): string {
  return join(root, manifest.buildId, manifest.exe)
}

const isBuildDir = (name: string): boolean => !name.startsWith('.') && name !== ACTIVE

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** Writes JSON through a temporary file, so a crash cannot truncate the real one. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = path + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, path)
}

export async function readManifest(root: string, buildId: string): Promise<BuildManifest | null> {
  return await readJson<BuildManifest>(join(root, buildId, MANIFEST))
}

/**
 * Everything wrong with a build, rather than the first thing wrong with it: a
 * caller deciding whether to fall back wants the whole picture, and so does
 * anyone reading the log afterwards.
 */
export async function verifyBuild(
  root: string,
  buildId: string,
  signal?: AbortSignal
): Promise<BuildProblem[]> {
  const problems: BuildProblem[] = []
  const fail = (problem: string): BuildProblem[] => [{ buildId, problem }]

  const manifest = await readManifest(root, buildId)
  if (!manifest) return fail('no build manifest')
  if (manifest.schema !== MANIFEST_SCHEMA) return fail('unsupported manifest schema ' + manifest.schema)
  if (manifest.buildId !== buildId) return fail('manifest names build ' + manifest.buildId)
  if (!manifest.exe || !manifest.files[manifest.exe]) return fail('manifest does not list its executable')

  const dir = join(root, buildId)
  let present: string[]
  try {
    present = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return fail('build directory is unreadable')
  }

  for (const [name, expected] of Object.entries(manifest.files)) {
    signal?.throwIfAborted()
    if (!present.includes(name)) { problems.push({ buildId, problem: name + ' is missing' }); continue }
    const actual = await sha256File(join(dir, name), signal)
    if (actual !== expected) problems.push({ buildId, problem: name + ' does not match its checksum' })
  }
  return problems
}

/**
 * Hashes the files that make up a build.
 *
 * `include` is what lets a build be named explicitly rather than inferred from
 * whatever happens to sit beside it. The vendored SimulationCraft download is
 * 539 MB, of which the CLI needs one 116 MB executable; the rest is the Qt GUI.
 * Measured, not assumed: simc.exe completes a full sim from a directory
 * containing nothing else.
 */
async function hashFiles(
  dir: string,
  include: readonly string[] | undefined,
  signal?: AbortSignal
): Promise<Record<string, string>> {
  const names = include ?? (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile()).map((e) => e.name)
  const files: Record<string, string> = {}
  for (const name of names) {
    signal?.throwIfAborted()
    files[name] = await sha256File(join(dir, name), signal)
  }
  return files
}

/**
 * A build id that changes whenever the bytes change, so two different builds can
 * never collide on one directory name. The version prefix is for humans reading
 * the folder; the hash is what makes it unique.
 */
export function buildIdFor(version: string | null, files: Record<string, string>): string {
  const digest = createHash('sha256')
  for (const name of Object.keys(files).sort()) digest.update(name + ':' + files[name] + '\n')
  const short = digest.digest('hex').slice(0, 12)
  // Dots are dropped rather than kept: a label is only a human hint, and an id
  // that began with one would be both a hidden directory and invisible to
  // listBuilds, which skips dot-names to ignore staging directories.
  const label = (version ?? 'unknown')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'unknown'
  return label + '-' + short
}

export interface StageResult {
  manifest: BuildManifest
  /** False when an identical build was already provisioned and verified. */
  copied: boolean
}

/**
 * Copies a build into its own directory and verifies it there.
 *
 * The copy lands in a staging directory and is renamed into place only once
 * every checksum matches, so an interrupted provision leaves no directory that
 * later looks like a usable build. An identical build that is already present
 * and verifies is reused rather than rewritten — that is what keeps this from
 * ever touching a build something else is running.
 */
export async function stageBuild(
  root: string,
  source: { dir: string; exe: string; version: string | null; source: string; include?: readonly string[] },
  signal?: AbortSignal
): Promise<StageResult> {
  await mkdir(root, { recursive: true })
  const files = await hashFiles(source.dir, source.include, signal)
  if (!files[source.exe]) throw new Error(source.exe + ' is not in ' + source.dir)
  const buildId = buildIdFor(source.version, files)

  if ((await verifyBuild(root, buildId, signal)).length === 0) {
    const manifest = await readManifest(root, buildId)
    if (manifest) return { manifest, copied: false }
  }

  const staging = await mkdtemp(join(root, STAGING_PREFIX))
  try {
    for (const name of Object.keys(files)) {
      signal?.throwIfAborted()
      await copyFile(join(source.dir, name), join(staging, name))
    }
    const manifest: BuildManifest = {
      schema: MANIFEST_SCHEMA,
      buildId,
      version: source.version,
      exe: source.exe,
      files,
      source: source.source,
      provisionedAt: new Date().toISOString()
    }
    await writeJsonAtomic(join(staging, MANIFEST), manifest)

    // Verify the copy, not the original: a truncated or corrupted write is
    // exactly what this is here to catch.
    for (const [name, expected] of Object.entries(files)) {
      signal?.throwIfAborted()
      if (await sha256File(join(staging, name), signal) !== expected) {
        throw new Error(name + ' was corrupted while being copied')
      }
    }

    // A directory already standing here is either a verified duplicate (returned
    // above) or damaged, and nothing can be running a build that fails
    // verification, so replacing it cannot pull a binary out from under anyone.
    await rm(join(root, buildId), { recursive: true, force: true })
    await rename(staging, join(root, buildId))
    return { manifest, copied: true }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

export async function readActive(root: string): Promise<ActiveRecord | null> {
  const record = await readJson<ActiveRecord>(join(root, ACTIVE))
  return record && record.schema === MANIFEST_SCHEMA ? record : null
}

/**
 * Points the app at a build, once it is known to be intact.
 *
 * Verification happens before the switch rather than after, so a failed
 * activation leaves the previous build active instead of leaving the app
 * pointing at something it cannot run.
 */
export async function activateBuild(
  root: string,
  buildId: string,
  signal?: AbortSignal
): Promise<BuildManifest> {
  const problems = await verifyBuild(root, buildId, signal)
  if (problems.length > 0) {
    throw new Error('Cannot activate ' + buildId + ': ' + problems.map((p) => p.problem).join('; '))
  }
  const manifest = await readManifest(root, buildId)
  if (!manifest) throw new Error('Cannot activate ' + buildId + ': manifest disappeared')

  const current = await readActive(root)
  if (current?.buildId === buildId) return manifest
  await writeJsonAtomic(join(root, ACTIVE), {
    schema: MANIFEST_SCHEMA,
    buildId,
    previousBuildId: current?.buildId ?? null,
    activatedAt: new Date().toISOString()
  } satisfies ActiveRecord)
  return manifest
}

/**
 * Puts back an earlier active record exactly — build and rollback target alike.
 *
 * Activation always records the build it replaces as the new predecessor, so
 * it cannot express "there was no previous build", and undoing a failed update
 * with it leaves the failed build as the rollback target. This writes the
 * record as it was, after checking the build it names is intact. A previous
 * build that no longer exists is recorded as none rather than kept dangling.
 */
export async function restoreActiveRecord(root: string, record: ActiveRecord): Promise<void> {
  const problems = await verifyBuild(root, record.buildId)
  if (problems.length > 0) {
    throw new Error('Cannot restore ' + record.buildId + ': ' + problems.map((q) => q.problem).join('; '))
  }
  const previousExists = record.previousBuildId !== null && (await readManifest(root, record.previousBuildId)) !== null
  await writeJsonAtomic(join(root, ACTIVE), {
    schema: MANIFEST_SCHEMA,
    buildId: record.buildId,
    previousBuildId: previousExists ? record.previousBuildId : null,
    activatedAt: record.activatedAt
  } satisfies ActiveRecord)
}

/** Every provisioned build, newest first, verified or not. */
export async function listBuilds(root: string): Promise<BuildManifest[]> {
  let names: string[]
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && isBuildDir(e.name)).map((e) => e.name)
  } catch {
    return []
  }
  const manifests = await Promise.all(names.map((name) => readManifest(root, name)))
  return manifests.filter((m): m is BuildManifest => m !== null)
    .sort((a, b) => b.provisionedAt.localeCompare(a.provisionedAt))
}

/** Returns to the build that was active before the current one. */
export async function rollback(root: string, signal?: AbortSignal): Promise<BuildManifest> {
  const current = await readActive(root)
  if (!current?.previousBuildId) throw new Error('There is no previous simc build to roll back to')
  // The record can outlive the build it names: retention prunes old builds, and
  // a directory can be deleted by hand. Say there is nothing to go back to,
  // rather than failing to activate a build that no longer exists.
  if (!(await readManifest(root, current.previousBuildId))) {
    throw new Error('There is no previous simc build to roll back to (' + current.previousBuildId + ' is no longer installed)')
  }
  return await activateBuild(root, current.previousBuildId, signal)
}

/**
 * Retention: the active build, the build it replaced, and the newest few others.
 *
 * `protect` is how a caller keeps a build it has pinned for a run in flight, so
 * activating a new build mid-run cannot delete the binary being executed.
 */
export async function pruneBuilds(
  root: string,
  options: { keep?: number; protect?: readonly string[] } = {}
): Promise<string[]> {
  const keep = Math.max(1, options.keep ?? 2)
  const active = await readActive(root)
  const protectedIds = new Set<string>(options.protect ?? [])
  if (active) {
    protectedIds.add(active.buildId)
    if (active.previousBuildId) protectedIds.add(active.previousBuildId)
  }
  const builds = await listBuilds(root)
  const removed: string[] = []
  let kept = protectedIds.size
  for (const build of builds) {
    if (protectedIds.has(build.buildId)) continue
    if (kept < keep) { kept++; continue }
    await rm(join(root, build.buildId), { recursive: true, force: true })
    removed.push(build.buildId)
  }
  return removed
}

/** Leftover staging directories from an interrupted provision. */
export async function cleanStaging(root: string): Promise<number> {
  let entries: string[]
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith(STAGING_PREFIX)).map((e) => e.name)
  } catch {
    return 0
  }
  for (const name of entries) await rm(join(root, name), { recursive: true, force: true })
  return entries.length
}

export interface Provisioned {
  root: string
  manifest: BuildManifest
  exe: string
  /** True when the bundled build had to be installed during this call. */
  installed: boolean
  /** Set when this call replaced the active build with a newer bundled one. */
  upgradedFrom: string | null
}

/**
 * Orders two simc build strings such as "1210-01" (patch 12.1.0, revision 01).
 *
 * Returns a negative number, zero or a positive number like a sort comparator,
 * or null when either side cannot be read — an unknown version is never
 * assumed to be newer or older than anything.
 */
export function compareSimcVersions(a: string | null, b: string | null): number | null {
  const parse = (v: string | null): number[] | null => {
    const match = v?.match(/^([0-9]+)-([0-9]+)$/)
    return match ? [Number(match[1]), Number(match[2])] : null
  }
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return null
  return left[0]! - right[0]! || left[1]! - right[1]!
}

/**
 * Whether a bundled build this app has not installed yet should take over.
 *
 * The bundled build is what shipped with the app being run, so unzipping a new
 * release over an old folder must bring its simulator with it — otherwise the
 * old build, still intact, keeps winning and the next WoW patch's /simc export
 * is refused by the version gate while the right binary sits unused in the
 * download. That is the bug this exists to fix.
 *
 * Two limits keep it from doing damage:
 * - It never downgrades. Running an older release over a newer install keeps
 *   the newer simulator; an older one could be missing the game data the
 *   profile now needs.
 * - A build someone chose on purpose (any source other than 'bundled') is only
 *   replaced by a strictly newer version, not by a same-version rebuild.
 *
 * Simc nightlies share one version string across many builds within a patch,
 * so a same-version, different-bytes bundled build does replace a previously
 * bundled one: this app shipped it, and nobody chose the old one.
 */
export function bundledShouldReplace(
  active: BuildManifest,
  bundledVersion: string | null
): boolean {
  const order = compareSimcVersions(bundledVersion, active.version)
  if (active.source === 'bundled') {
    if (order === null) return bundledVersion !== null || active.version === null
    return order >= 0
  }
  return order !== null && order > 0
}

/**
 * Guarantees a usable simulator, installing or upgrading to the bundled one.
 *
 * Called at startup. An intact active build is kept unless the app now ships a
 * newer one (see `bundledShouldReplace`); the build it replaces stays installed
 * as the rollback target. With no usable active build, any other intact build
 * is preferred over reinstalling, because a build already on disk is equally
 * valid and far cheaper than copying 116 MB again.
 */
export async function ensureProvisioned(
  dataDir: string,
  bundled: { dir: string; exe: string; version: string | null; include?: readonly string[] },
  signal?: AbortSignal
): Promise<Provisioned> {
  const root = buildsRoot(dataDir)
  await mkdir(root, { recursive: true })
  await cleanStaging(root)

  const result = (manifest: BuildManifest, installed: boolean, upgradedFrom: string | null = null): Provisioned =>
    ({ root, manifest, exe: exePath(root, manifest), installed, upgradedFrom })

  const active = await readActive(root)
  const activeManifest = active && (await verifyBuild(root, active.buildId, signal)).length === 0
    ? await readManifest(root, active.buildId)
    : null

  if (activeManifest) {
    // Hashing the bundled executable is what tells a new release's simulator
    // apart from the one already installed. It runs in the background at
    // startup, so it costs a moment of provisioning, not a blank window.
    const bundledPresent = await stat(join(bundled.dir, bundled.exe)).then(() => true, () => false)
    if (!bundledPresent) return result(activeManifest, false)
    const bundledId = buildIdFor(bundled.version, await hashFiles(bundled.dir, bundled.include, signal))
    if (bundledId === activeManifest.buildId) return result(activeManifest, false)

    const alreadyInstalled = await readManifest(root, bundledId)
    const knownBundled = alreadyInstalled && (await verifyBuild(root, bundledId, signal)).length === 0
    // A bundled build that is already installed but not active was set aside on
    // purpose (a rollback, or a deliberate switch). Offering it again on every
    // launch would undo that choice.
    if (knownBundled) return result(activeManifest, false)

    if (!bundledShouldReplace(activeManifest, bundled.version)) return result(activeManifest, false)
    const staged = await stageBuild(root, { ...bundled, source: 'bundled' }, signal)
    const manifest = await activateBuild(root, staged.manifest.buildId, signal)
    return result(manifest, staged.copied, activeManifest.buildId)
  }

  for (const candidate of await listBuilds(root)) {
    if ((await verifyBuild(root, candidate.buildId, signal)).length > 0) continue
    const manifest = await activateBuild(root, candidate.buildId, signal)
    return result(manifest, false)
  }

  await stat(join(bundled.dir, bundled.exe))
  const staged = await stageBuild(root, { ...bundled, source: 'bundled' }, signal)
  const manifest = await activateBuild(root, staged.manifest.buildId, signal)
  return result(manifest, staged.copied)
}
