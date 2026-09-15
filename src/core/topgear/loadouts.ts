/**
 * Talent loadout comparison.
 *
 * The SimC addon export carries every saved loadout as commented-out
 * `# Saved Loadout: <name>` / `# talents=<string>` pairs. The parser
 * already keeps them, so comparing them costs one profileset batch and no new
 * data at all.
 *
 * Profileset results carry statistics only, which is exactly enough to
 * rank loadouts. A detailed report for a winner needs a standalone run, the
 * same constraint M7 works under.
 */
import type { Profile } from '../types.ts'
import { runSim, type SimProgress, type RunOptions, type RunResult } from '../simc/runner.ts'
import { PROFILESET_WORK_THREADS } from './funnel.ts'

export interface LoadoutEntry {
  /** Every saved name sharing this talent string. Duplicates are common. */
  names: string[]
  talents: string
  /** True when this matches the profile's active talents. */
  isCurrent: boolean
}

export interface LoadoutResult extends LoadoutEntry {
  dps: number
  error: number
  /** DPS relative to the profile's active talents. */
  delta: number
  deltaPct: number
  /** True when the gap to the baseline is inside combined error bars. */
  withinNoise: boolean
}

export interface LoadoutComparison {
  baselineDps: number
  baselineError: number
  results: LoadoutResult[]
  /** Saved loadouts that were skipped, with the reason. */
  skipped: Array<{ name: string; reason: string }>
  durationMs: number
}

/**
 * Collapses saved loadouts to distinct talent strings.
 *
 * Players routinely save the same build under several names — fixture #1 has 14
 * saved loadouts but fewer distinct strings — and simming identical talents
 * repeatedly wastes the whole budget on a guaranteed tie.
 */
export function distinctLoadouts(profile: Profile): {
  entries: LoadoutEntry[]
  skipped: Array<{ name: string; reason: string }>
} {
  const byTalents = new Map<string, LoadoutEntry>()
  const skipped: Array<{ name: string; reason: string }> = []

  const active = profile.talents?.trim()
  if (active) {
    byTalents.set(active, { names: ['Current'], talents: active, isCurrent: true })
  }

  for (const loadout of profile.savedLoadouts) {
    const talents = loadout.talents.trim()
    if (!talents) {
      skipped.push({ name: loadout.name, reason: 'No talent string' })
      continue
    }
    const existing = byTalents.get(talents)
    if (existing) {
      existing.names.push(loadout.name)
      continue
    }
    byTalents.set(talents, { names: [loadout.name], talents, isCurrent: false })
  }

  return { entries: [...byTalents.values()], skipped }
}

/** simc profileset names must be short and unique. */
const name = (i: number): string => `l${i}`

export function buildLoadoutInput(
  profile: Profile,
  entries: readonly LoadoutEntry[],
  opts: { threads?: number; targetError?: number; iterations?: number; fightSeconds?: number }
): string {
  const lines = [profile.raw.trimEnd(), '']
  if (opts.threads !== undefined) lines.push(`threads=${opts.threads}`)
  if (opts.fightSeconds !== undefined) lines.push(`max_time=${opts.fightSeconds}`)
  if (opts.targetError !== undefined) {
    lines.push('iterations=1000000', `target_error=${opts.targetError}`)
  } else {
    lines.push(`iterations=${opts.iterations ?? 5000}`)
  }
  lines.push(
    'profileset_metric=dps',
    `profileset_work_threads=${PROFILESET_WORK_THREADS}`,
    ''
  )
  entries.forEach((entry, i) => {
    lines.push(`profileset."${name(i)}"=talents=${entry.talents}`)
  })
  lines.push('')
  return lines.join('\n')
}

interface LoadoutJson {
  sim?: {
    profilesets?: { results?: Array<{ name?: string; mean?: number; mean_error?: number }> }
  }
}

export interface LoadoutOptions {
  simcPath: string
  threads?: number
  targetError?: number
  iterations?: number
  fightSeconds?: number
  signal?: AbortSignal
  onProgress?: (p: SimProgress) => void
  run?: (opts: RunOptions) => Promise<RunResult>
}

export async function compareLoadouts(
  profile: Profile,
  opts: LoadoutOptions
): Promise<LoadoutComparison> {
  const started = Date.now()
  const { entries, skipped } = distinctLoadouts(profile)
  if (entries.length === 0) {
    throw new Error('This profile has no talent loadouts to compare.')
  }

  const run = await (opts.run ?? runSim)({
    simcPath: opts.simcPath,
    input: buildLoadoutInput(profile, entries, opts),
    leanReport: true,
    signal: opts.signal,
    onProgress: opts.onProgress
  })

  const results = (run.json as LoadoutJson).sim?.profilesets?.results ?? []
  const byName = new Map(results.map((r) => [r.name ?? '', r]))

  // Every loadout is simmed as a profileset, including the current one, so the
  // baseline comes from the same batch and the same iteration count. Comparing
  // against a separately-run baseline would fold in run-to-run variance.
  const currentIndex = entries.findIndex((e) => e.isCurrent)
  const currentResult = currentIndex >= 0 ? byName.get(name(currentIndex)) : undefined
  if (!currentResult) throw new Error('simc returned no result for the current talent loadout.')
  const valid = (r: { mean?: number; mean_error?: number }): r is { mean: number; mean_error?: number } =>
    Number.isFinite(r.mean) && r.mean! > 0 && (r.mean_error === undefined || (Number.isFinite(r.mean_error) && r.mean_error >= 0))
  if (!valid(currentResult)) throw new Error('simc returned invalid numerical results for the current talent loadout.')
  const baselineDps = currentResult.mean
  const baselineError = currentResult.mean_error ?? 0

  const ranked: LoadoutResult[] = entries
    .map((entry, i) => {
      const r = byName.get(name(i))
      if (!r || !valid(r)) return null
      const delta = r.mean - baselineDps
      const error = r.mean_error ?? 0
      return {
        ...entry,
        dps: r.mean,
        error,
        delta,
        deltaPct: (delta / baselineDps) * 100,
        withinNoise: Math.abs(delta) <= error + baselineError
      }
    })
    .filter((r): r is LoadoutResult => r !== null)
    .sort((a, b) => b.dps - a.dps)

  for (const entry of entries) {
    if (!ranked.some((r) => r.talents === entry.talents)) {
      skipped.push({ name: entry.names[0], reason: 'simc returned no valid numerical result for this loadout' })
    }
  }

  return {
    baselineDps,
    baselineError,
    results: ranked,
    skipped,
    durationMs: Date.now() - started
  }
}
