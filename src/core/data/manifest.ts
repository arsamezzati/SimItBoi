/**
 * The one declaration of what generated data the app ships, and the identity of
 * each file.
 *
 * Two problems this exists to stop happening again:
 *
 * 1. **A file nobody remembered to ship.** Each data file used to be listed by
 *    hand in electron.vite.config.ts, separately from the code that requires it.
 *    `dawncrest-crafts.json` was added without that edit, so the built bundle
 *    required a file that was never written and packaged builds threw on first
 *    use. The bundler now emits exactly this list, so adding a file here is the
 *    only step.
 * 2. **Identity by timestamp.** Data identities were `v1:<generated>:<season>`,
 *    so regenerating a file with byte-identical contents produced a new identity
 *    and invalidated every saved scenario. Identity is now the content hash:
 *    same data, same id.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * Every generated JSON the main process requires at runtime, resolved relative
 * to this module in both dev and a packaged build.
 *
 * `item-icons.json` is deliberately absent: the renderer imports it statically,
 * so the bundler already includes it and there is nothing to emit.
 */
export const DATA_FILES = [
  'items.json',
  'db2.json',
  'season1-gear.json',
  'season2-gear.json',
  'dawncrest-crafts.json',
  'spec-weapons.json'
] as const

export type DataFile = (typeof DATA_FILES)[number]

const require_ = createRequire(import.meta.url)
const hashes = new Map<string, string>()

/**
 * Content identity: the first 12 hex of the file's SHA-256. Short enough to
 * read in a report, long enough that a collision is not a practical concern for
 * a handful of files.
 */
export function dataIdentity(file: DataFile): string {
  const cached = hashes.get(file)
  if (cached) return cached
  const bytes = readFileSync(require_.resolve(`./${file}`))
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`
  hashes.set(file, hash)
  return hash
}

/**
 * Fields that say when a file was made rather than what is in it.
 *
 * Both season generators stamp `generated` on every run, so a rebuild of
 * byte-identical data produced a different hash and invalidated every saved
 * selection. A user who rebuilt the catalog was told all their configured items
 * were stale when nothing about them had changed.
 */
const VOLATILE_FIELDS = new Set(['generated'])

/**
 * Serializes deterministically, so two objects with the same content hash the
 * same regardless of key order — which JSON.stringify otherwise preserves from
 * whatever order the generator happened to build them in.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !VOLATILE_FIELDS.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}'
}

const semanticHashes = new Map<string, string>()

/**
 * What a file *means*, ignoring when it was generated.
 *
 * This is the identity to compare for compatibility: whether a saved selection
 * still describes the same items and rules. `dataIdentity` remains the identity
 * of the exact bytes, which is what a report's provenance needs — those two
 * questions have different right answers and used to share one hash.
 */
export function semanticIdentity(file: DataFile): string {
  const cached = semanticHashes.get(file)
  if (cached) return cached
  const parsed = require_('./' + file) as unknown
  const hash = 'sha256:' + createHash('sha256').update(canonical(parsed)).digest('hex').slice(0, 12)
  semanticHashes.set(file, hash)
  return hash
}

/**
 * One identity for a group of files, so a catalog spanning two snapshots still
 * has a single stable id. Hashes the members' semantic identities rather than
 * their bytes, which keeps it cheap, order-independent, and stable across a
 * rebuild that changed nothing but the clock.
 */
export function combinedIdentity(files: readonly DataFile[]): string {
  const parts = [...files].sort().map((f) => semanticIdentity(f)).join('|')
  return 'sha256:' + createHash('sha256').update(parts).digest('hex').slice(0, 12)
}

/** Every file's identity, for a run envelope. */
export function dataIdentities(): Record<DataFile, string> {
  return Object.fromEntries(DATA_FILES.map((f) => [f, dataIdentity(f)])) as Record<DataFile, string>
}

interface Stamped {
  version?: number
  /** db2.json calls it `build`; dawncrest-crafts.json calls it `gameBuild`. */
  build?: string
  gameBuild?: string
  [key: string]: unknown
}

export interface SnapshotProblem {
  file: string
  problem: string
}

/**
 * What each file must actually contain to be usable.
 *
 * Validation used to check only that `version` was a number, which six files
 * containing nothing but `{version, gameBuild}` passed while carrying none of
 * the data the app requires. A schema version is a claim about shape; this is
 * the shape.
 *
 * `schema` lists the versions this build knows how to read. A file from the
 * future is refused rather than parsed hopefully — that is the whole point of
 * stamping a version on it.
 */
interface Requirement {
  schema: readonly number[]
  /** Arrays that must be present and non-empty, with the minimum expected. */
  arrays?: Readonly<Record<string, number>>
  /** Objects whose keys are records, with the minimum count expected. */
  maps?: Readonly<Record<string, number>>
}

/**
 * Minimums are deliberately far below the real counts: they catch an empty or
 * truncated file, not a legitimate change in the game's data. `db2.json` ships
 * 46 embellishments today and a patch may change that; zero or one means the
 * derivation broke.
 */
const REQUIRED: Readonly<Record<DataFile, Requirement>> = {
  'items.json': { schema: [3], maps: { items: 1000, sets: 1 } },
  'db2.json': {
    schema: [3],
    arrays: { embellishments: 5, gems: 5, enchants: 50 },
    maps: { limitCategories: 10, itemLimitCategory: 1, weaponProficiency: 13 }
  },
  'season1-gear.json': { schema: [1], arrays: { items: 100 } },
  'season2-gear.json': { schema: [1], arrays: { items: 100 } },
  'dawncrest-crafts.json': { schema: [2], arrays: { items: 10 } },
  'spec-weapons.json': { schema: [1], arrays: { specs: 39 }, maps: { specsByKey: 39 } }
}

function checkShape(file: DataFile, parsed: Stamped): SnapshotProblem[] {
  const problems: SnapshotProblem[] = []
  const required = REQUIRED[file]
  const add = (problem: string): void => { problems.push({ file, problem }) }

  if (typeof parsed.version !== 'number') add('no schema version')
  else if (!required.schema.includes(parsed.version)) {
    add('schema version ' + parsed.version + ' is not supported (expected ' + required.schema.join(' or ') + ')')
  }

  for (const [key, minimum] of Object.entries(required.arrays ?? {})) {
    const value = parsed[key]
    if (!Array.isArray(value)) add(key + ' is missing or not an array')
    else if (value.length < minimum) add(key + ' holds ' + value.length + ' entries, expected at least ' + minimum)
  }

  for (const [key, minimum] of Object.entries(required.maps ?? {})) {
    const value = parsed[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) add(key + ' is missing or not an object')
    else {
      const size = Object.keys(value as object).length
      if (size < minimum) add(key + ' holds ' + size + ' entries, expected at least ' + minimum)
    }
  }
  return problems
}

/**
 * Checks the shipped snapshot before anything depends on it: every declared
 * file present, parseable, of a schema version this build understands, holding
 * the data it is supposed to hold, and agreeing on the game build.
 *
 * Returns problems rather than throwing so a caller can surface all of them at
 * once instead of the first. A non-empty result means the snapshot must not be
 * used — see `assertUsableSnapshot`.
 */
export function validateDataSnapshot(): SnapshotProblem[] {
  const problems: SnapshotProblem[] = []
  const builds = new Map<string, string[]>()
  for (const file of DATA_FILES) {
    let parsed: Stamped
    try {
      parsed = require_('./' + file) as Stamped
    } catch (error) {
      problems.push({ file, problem: 'missing or unreadable: ' + (error as Error).message })
      continue
    }
    problems.push(...checkShape(file, parsed))
    const build = parsed.build ?? parsed.gameBuild
    if (build) {
      const files = builds.get(build)
      if (files) files.push(file)
      else builds.set(build, [file])
    }
  }
  // Files that name a game build must name the same one, or they describe
  // different games and any cross-file join between them is meaningless.
  if (builds.size > 1) {
    const detail = [...builds].map(([build, files]) => build + ' (' + files.join(', ') + ')').join(' vs ')
    problems.push({ file: 'snapshot', problem: 'game build disagreement: ' + detail })
  }
  return problems
}

let cachedProblems: SnapshotProblem[] | null = null

/** The snapshot's problems, computed once. */
export function snapshotProblems(): SnapshotProblem[] {
  cachedProblems ??= validateDataSnapshot()
  return cachedProblems
}

/**
 * Refuses to proceed on a snapshot that did not validate.
 *
 * Validation used to be advisory: problems were logged at startup and exposed
 * in envInfo, and then every consumer carried on regardless. A snapshot the app
 * has already decided is unusable must not reach configuration or simulation,
 * because what comes out the other side looks like an answer.
 */
export function assertUsableSnapshot(): void {
  const problems = snapshotProblems()
  if (problems.length === 0) return
  const detail = problems.map((p) => p.file + ': ' + p.problem).join('; ')
  throw new Error('SimItBoi’s bundled data is not usable and it cannot simulate. ' + detail)
}