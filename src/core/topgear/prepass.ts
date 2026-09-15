/**
 * Top Gear pre-pass.
 *
 * Produces the two inputs the shortlist heuristic needs:
 *   1. Stat weights, from a scale-factor sim.
 *   2. Each candidate item's true DPS delta in isolation, from one profileset
 *      batch. This captures trinket procs and item effects that stat weights
 *      miss entirely.
 *
 * Constraint from M0: a profileset result exposes only `name` as the
 * key back to its inputs — `profileset_output_data=1` returns an empty
 * `overrides` object. So names are compact generated ids and the mapping is
 * held here, never encoded into the name string.
 */
import type { CandidateItem, Profile } from '../types.ts'
import { emitItemString } from '../parser/addonProfile.ts'
import { runSim, type SimProgress } from '../simc/runner.ts'
import { canEquip, lookupItem, uniqueRuleFor } from '../data/itemTable.ts'
import { satisfiesUniqueRules } from '../data/unique.ts'
import { allowedConfigs, inferConfig, isLegalPair, rulesFor } from './weapons.ts'
import { PROFILESET_WORK_THREADS } from './funnel.ts'

export type StatWeights = Record<string, number>

export interface ItemDelta {
  candidate: CandidateItem
  /** Absolute DPS with this item equipped. */
  dps: number
  /** DPS relative to the unmodified profile. */
  delta: number
  /** simc's mean_error for this profileset. */
  error: number
}

export interface PrepassResult {
  weights: StatWeights
  baselineDps: number
  deltas: ItemDelta[]
  candidates: CandidateItem[]
  /** Candidates simc refused — wrong armour type, etc. */
  rejected: RejectedCandidate[]
  durationMs: number
}

export interface FilterOptions {
  /** Drop anything below this ilvl. Default: min equipped ilvl − 30. */
  ilvlFloor?: number
  /** Hover probes need every exact variant; the DPS pre-pass still dedupes ids. */
  preserveVariants?: boolean
}

/**
 * Whether the character currently wields a two-hander.
 *
 * The addon emits no weapon-type metadata, but an equipped set with a
 * main hand and NO off hand can only be a 2H. That single bit is enough to kill
 * the phantom-upgrade bug below.
 */
export function wieldsTwoHander(profile: Profile): boolean {
  const hasMain = profile.equipped.some((c) => c.slotClass === 'main_hand')
  const hasOff = profile.equipped.some((c) => c.slotClass === 'off_hand')
  return hasMain && !hasOff
}

/**
 * The two cheapest filters, worth eight orders of magnitude on real bags:
 * an ilvl floor and same-item-id dedupe keeping the highest ilvl.
 *
 * Validates each single-slot swap against metadata. simc does NOT validate this:
 * it will equip a shield alongside a staff, hand out the free stats, and report
 * a large phantom upgrade. Measured at +16,887 DPS on fixture #1 before this
 * filter existed. An off-hand is only viable together with a 1H main
 * hand, which is a paired change the combo generator owns (M6) — it cannot be
 * evaluated by swapping one slot in isolation.
 */
export function filterCandidates(profile: Profile, opts: FilterOptions = {}): CandidateItem[] {
  const equippedIlvls = profile.equipped.map((c) => c.ilvl).filter((n) => n > 0)
  const floor =
    opts.ilvlFloor ?? (equippedIlvls.length > 0 ? Math.min(...equippedIlvls) - 30 : 0)

  const pool = [...profile.equipped, ...profile.bagItems].filter(
    (c) =>
      c.ilvl >= floor &&
      // Validate the resulting weapon/ring/trinket pair before simc sees it.
      isLegalSingleSwap(profile, c) &&
      // Wrong armour class — dropped here so simc never aborts the batch.
      canEquip(profile.className, c.item.id)
  )

  if (opts.preserveVariants) return pool.sort((a, b) => b.ilvl - a.ilvl)

  // Same item id at multiple ilvls: keep the highest.
  const best = new Map<string, CandidateItem>()
  for (const c of pool) {
    const key = `${c.slotClass}:${c.item.id}`
    const prev = best.get(key)
    if (!prev || c.ilvl > prev.ilvl) best.set(key, c)
  }
  return [...best.values()].sort((a, b) => b.ilvl - a.ilvl)
}

/** Validate the actual equipment left after a position-1 pre-pass replacement. */
export function isLegalSingleSwap(profile: Profile, candidate: CandidateItem): boolean {
  const slot = candidate.slotClass
  if (slot === 'finger' || slot === 'trinket') {
    const other = profile.equipped.find((c) => c.item.emittedSlot === `${slot}2`)
    // A single physical copy cannot occupy both positions.
    if (other === candidate) return false
    return satisfiesUniqueRules([candidate, ...(other ? [other] : [])].map((c) => ({
      id: c.item.id, rule: uniqueRuleFor(c)
    })))
  }
  if (slot !== 'main_hand' && slot !== 'off_hand') return true
  const rules = rulesFor(profile)
  if (!rules) return false
  const lookup = (c: CandidateItem) => lookupItem(c.item.id)?.weaponType
  const mh = slot === 'main_hand' ? candidate : profile.equipped.find((c) => c.slotClass === 'main_hand')
  const oh = slot === 'off_hand' ? candidate : profile.equipped.find((c) => c.slotClass === 'off_hand')
  if (!mh || !lookup(mh) || (oh && !lookup(oh))) return false
  return allowedConfigs(profile, inferConfig(profile, lookup), rules).some((config) =>
    isLegalPair(config, lookup(mh), oh ? lookup(oh) : undefined, rules))
}

/**
 * The slot name to write in a profileset override.
 *
 * Bag items are always emitted as slot 1, so paired slots are normalised
 * to position 1 here. A delta measured against position 1 is sufficient for
 * ranking; exact placement is the combo generator's job (M6).
 */
function overrideSlot(c: CandidateItem): string {
  if (c.slotClass === 'finger') return 'finger1'
  if (c.slotClass === 'trinket') return 'trinket1'
  return c.slotClass
}

/** simc profileset names must be stable, unique and compact. */
function profilesetName(index: number): string {
  return `c${index}`
}

export function buildPrepassInput(
  profile: Profile,
  candidates: CandidateItem[],
  opts: { iterations?: number; targetError?: number; threads?: number } = {}
): string {
  const lines: string[] = [profile.raw.trimEnd(), '']

  if (opts.targetError !== undefined) lines.push(`target_error=${opts.targetError}`)
  else lines.push(`iterations=${opts.iterations ?? 1000}`)
  if (opts.threads !== undefined) lines.push(`threads=${opts.threads}`)
  // Measured: without this a profileset batch barely scales with cores.
  lines.push('profileset_metric=dps', `profileset_work_threads=${PROFILESET_WORK_THREADS}`, '')

  candidates.forEach((c, i) => {
    lines.push(`profileset."${profilesetName(i)}"=${emitItemString(c.item, overrideSlot(c))}`)
  })
  lines.push('')
  return lines.join('\n')
}

interface ProfilesetResult {
  name?: string
  mean?: number
  mean_error?: number
}

interface PrepassJson {
  sim?: {
    players?: Array<{
      scale_factors?: StatWeights
      collected_data?: { dps?: { mean?: number } }
    }>
    profilesets?: { results?: ProfilesetResult[] }
  }
}

export interface PrepassOptions extends FilterOptions {
  simcPath: string
  iterations?: number
  targetError?: number
  threads?: number
  onProgress?: (p: SimProgress) => void
}

/**
 * Runs both halves of the pre-pass.
 *
 * Two simc invocations, not one: scale factors need a full run, while the
 * delta batch is a profileset run. Both use report_details=0 — 24x smaller
 * output, and it keeps everything either half reads.
 */
export async function runPrepass(
  profile: Profile,
  opts: PrepassOptions
): Promise<PrepassResult> {
  const started = Date.now()
  const candidates = filterCandidates(profile, opts)

  const iterationLine =
    opts.targetError !== undefined
      ? `target_error=${opts.targetError}`
      : `iterations=${opts.iterations ?? 1000}`
  const threadLine = opts.threads !== undefined ? `threads=${opts.threads}\n` : ''

  // --- 1. Stat weights ----------------------------------------------------
  const sfRun = await runSim({
    simcPath: opts.simcPath,
    input: `${profile.raw.trimEnd()}\n${iterationLine}\n${threadLine}calculate_scale_factors=1\n`,
    leanReport: true,
    onProgress: opts.onProgress
  })
  const sfPlayer = (sfRun.json as PrepassJson).sim?.players?.[0]
  const weights = sfPlayer?.scale_factors ?? {}
  const baselineDps = sfPlayer?.collected_data?.dps?.mean ?? 0

  // --- 2. Per-item deltas -------------------------------------------------
  const { results, rejected } = await runDeltaBatch(profile, candidates, opts)
  const byName = new Map(results.map((r) => [r.name ?? '', r]))

  const deltas: ItemDelta[] = candidates
    .map((candidate, i) => {
      const r = byName.get(profilesetName(i))
      if (!r || r.mean === undefined) return null
      return {
        candidate,
        dps: r.mean,
        delta: r.mean - baselineDps,
        error: r.mean_error ?? 0
      }
    })
    .filter((d): d is ItemDelta => d !== null)
    .sort((a, b) => b.delta - a.delta)

  return {
    weights,
    baselineDps,
    deltas,
    candidates,
    rejected,
    durationMs: Date.now() - started
  }
}

/** `Error: Profileset 'c42': Player 'X': Item 'y' Slot 'legs': Invalid type.` */
const RE_PROFILESET_ERROR = /Profileset '([^']+)'\s*:\s*([^\r\n]+)/

export interface RejectedCandidate {
  candidate: CandidateItem
  reason: string
}

/**
 * Runs the delta batch, surviving unequippable candidates.
 *
 * M0 follow-up: a single item the character cannot equip — bags hold
 * gear for other armour types — makes simc abort the WHOLE batch with exit 82.
 * simc names the offending profileset in the error, so drop it and retry.
 * Bounded, because each retry re-runs the batch.
 */
async function runDeltaBatch(
  profile: Profile,
  candidates: CandidateItem[],
  opts: PrepassOptions,
  maxDrops = 12
): Promise<{ results: ProfilesetResult[]; rejected: RejectedCandidate[] }> {
  const excluded = new Set<number>()
  const rejected: RejectedCandidate[] = []

  for (let attempt = 0; attempt <= maxDrops; attempt++) {
    const active = candidates
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => !excluded.has(i))

    const lines: string[] = [profile.raw.trimEnd(), '']
    if (opts.targetError !== undefined) lines.push(`target_error=${opts.targetError}`)
    else lines.push(`iterations=${opts.iterations ?? 1000}`)
    if (opts.threads !== undefined) lines.push(`threads=${opts.threads}`)
    lines.push('profileset_metric=dps', `profileset_work_threads=${PROFILESET_WORK_THREADS}`, '')
    for (const { c, i } of active) {
      lines.push(`profileset."${profilesetName(i)}"=${emitItemString(c.item, overrideSlot(c))}`)
    }

    try {
      const run = await runSim({
        simcPath: opts.simcPath,
        input: `${lines.join('\n')}\n`,
        leanReport: true,
        onProgress: opts.onProgress
      })
      return { results: (run.json as PrepassJson).sim?.profilesets?.results ?? [], rejected }
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout ?? ''
      const m = stdout.match(RE_PROFILESET_ERROR)
      if (!m) throw err
      const index = candidates.findIndex((_, i) => profilesetName(i) === m[1])
      if (index === -1 || excluded.has(index)) throw err
      excluded.add(index)
      rejected.push({ candidate: candidates[index], reason: m[2].trim() })
    }
  }

  throw new Error(`Gave up after dropping ${maxDrops} unequippable candidates`)
}
