import { availableParallelism, freemem } from 'node:os'
import { PAIRED_SLOTS, type CandidateItem, type Profile } from '../types.ts'
import { parseAddonProfile, emitItemString } from '../parser/addonProfile.ts'
import { canEquip, itemTable, lookupItem, uniqueRuleFor } from '../data/itemTable.ts'
import { restrictionsWith } from '../data/embellish.ts'
import { canWieldWeapon } from '../data/db2.ts'
import { rulesFor } from './weapons.ts'
import { parseHypotheticals, declarationsFrom, type HypotheticalInput, type HypotheticalError } from './hypothetical.ts'
import { probeVersion, runSim, type RunOptions, type RunResult, type SimcVersion } from '../simc/runner.ts'
import { extractReport, type SimReport } from '../report/extract.ts'
import { solveTopGear, gearKey, combinationOverrides, type Combination, type Gear } from './solver.ts'
import { itemStatKey } from '../data/itemStats.ts'
import { sha256File } from '../simc/identity.ts'
import { requireCompatibleSimc } from '../simc/versionGate.ts'

export interface CandidateOption {
  id: number; name: string; ilvl: number; slot: string
  source: 'equipped' | 'bags' | 'hypothetical'; itemString: string
  supported: boolean; reason?: string
  /** Exact variant+placement identity; distinct from physical copy id. */
  statKey: string
}
export function describeCandidates(profile: Profile): CandidateOption[] {
  return [...profile.equipped, ...profile.bagItems].map((c, id) => {
    const meta = lookupItem(c.item.id)
    const reason = !meta ? 'Missing item metadata' : !canEquip(profile.className, c.item.id) ? 'Wrong armor class'
      : PAIRED_SLOTS.includes(c.slotClass) && uniqueRuleFor(c).kind === 'unknown'
        ? 'Unknown unique restriction' : undefined
    return { id, name: c.name || `Item ${c.item.id}`, ilvl: c.ilvl, slot: c.slotClass, statKey: itemStatKey(c),
      source: c.source, itemString: emitItemString(c.item), supported: !reason, reason }
  })
}
export interface TopGearOptions {
  selectedIds: number[]
  budgetSeconds: number
  threads?: number
  fightSeconds?: number
  targets?: number
  /**
   * Gear the user declared but does not own. Appended to the candidate
   * pool after the owned items, so `selectedIds` indexes stay stable.
   */
  hypothetical?: HypotheticalInput[]
}
export interface TopGearProgress { stage: string; fraction: number; detail: string }
export interface GearDiff { slot: string; before: string; after: string; beforeItem: string; afterItem: string }
export interface RankedCombination {
  id: string; dps: number; error: number; delta: number; deltaPct: number
  report: SimReport; durationMs: number; changes: GearDiff[]; overrides: string[]; tier: Combination['tier']
  reusedBaseline: boolean
}
export interface TopGearResult {
  schemaVersion?: 2
  /** Original structured choices for restoring this scenario from history. */
  options?: TopGearOptions
  baseline: SimReport
  baselineDurationMs: number
  ranking: RankedCombination[]
  warnings: string[]
  rejected: Array<{ description: string; reason: string }>
  combinationCount: string
  shortlisted: number
  stageOneSimulated: number
  detailedSimulated: number
  durationMs: number
  version: SimcVersion
  binarySha256: string
  metadata: { version: number; generated: string; namespace: string }
  settings: { budgetSeconds: number; threads: number; fightSeconds: number; targets: number; looseError: number; tightError: number; estimatedMsPerCombination: number }
  input: string
  selectedIds: number[]
  /** Declared items that failed validation, with the reason. */
  hypotheticalRejected: HypotheticalError[]
  /** Declared items that were accepted into the pool. */
  hypotheticalAccepted: Array<{ name: string; slot: string; itemString: string; embellished?: boolean; ilvl?: number }>
}
interface Dependencies {
  run?: (opts: RunOptions) => Promise<RunResult>
  probe?: (path: string, signal?: AbortSignal) => Promise<SimcVersion | null>
  hardware?: { threads: number; freeMemory: number }
  now?: () => number
  fingerprint?: (path: string, signal?: AbortSignal) => Promise<string>
}
interface BatchEntry { id: string; gear: Gear }
interface Metric { name: string; mean: number; mean_error: number }

export function planShortlist(remainingMs: number, looseMs: number, detailMs: number, memoryLimit: number): { size: number; finalists: number } {
  if (![remainingMs, looseMs, detailMs, memoryLimit].every(Number.isFinite) || looseMs <= 0 || detailMs <= 0 || memoryLimit < 1) throw new Error('Invalid calibration measurement')
  const finalists = Math.max(1, Math.min(20, Math.floor(Math.max(0, remainingMs) * 0.4 / detailMs)))
  const size = Math.max(1, Math.min(Math.floor(memoryLimit), Math.floor((remainingMs - finalists * detailMs) / looseMs)))
  return { size, finalists: Math.min(finalists, size) }
}

/**
 * Threads to give each profileset. Measured: leaving this at simc's
 * default makes a profileset batch barely scale with cores at all — 8, 16 and
 * 24 threads all took ~5.6-6.0 s on the same 43-profileset batch. Setting it
 * lets the batch scale properly: 24 threads drops to 3.7 s, a 36% saving.
 *
 * 2 measured best at 8 threads and is within noise of the best at 16 and 24,
 * so it is the safest single choice across the hardware range.
 */
export const PROFILESET_WORK_THREADS = 2

export function buildBatchInput(base: string, entries: readonly BatchEntry[], settings: string): string {
  const lines = [
    base.trimEnd(),
    settings,
    'profileset_metric=dps',
    `profileset_work_threads=${PROFILESET_WORK_THREADS}`
  ]
  const ids = new Set<string>()
  for (const entry of entries) {
    if (!/^[a-z]\d+$/.test(entry.id) || ids.has(entry.id)) throw new Error('Invalid or duplicate profileset identifier')
    ids.add(entry.id)
    combinationOverrides({ gear: entry.gear }).forEach((line, i) => lines.push(`profileset."${entry.id}"${i ? '+' : ''}=${line}`))
  }
  return `${lines.join('\n')}\n`
}

export function gearDifferences(profile: Profile, gear: Gear): GearDiff[] {
  const before: Record<string, CandidateItem> = Object.fromEntries(profile.equipped.map((c) => [c.item.emittedSlot, c]))
  const after = { ...gear }
  // Ring/trinket positions have no semantic difference; keep matching items in
  // their old position so the UI doesn't report a swap of two unchanged rings.
  for (const slot of ['finger', 'trinket']) {
    const same = (a?: CandidateItem | null, b?: CandidateItem | null): boolean => !!a && !!b && emitItemString(a.item, 'item') === emitItemString(b.item, 'item')
    if (same(before[`${slot}1`], after[`${slot}2`]) || same(before[`${slot}2`], after[`${slot}1`])) {
      [after[`${slot}1`], after[`${slot}2`]] = [after[`${slot}2`], after[`${slot}1`]]
    }
  }
  return Object.entries(after).flatMap(([slot, item]) => {
    const previous = before[slot]
    const beforeItem = previous ? emitItemString(previous.item, slot) : `${slot}=none`
    const afterItem = item ? emitItemString(item.item, slot) : `${slot}=none`
    return beforeItem === afterItem ? [] : [{ slot, before: previous ? `${previous.name} (${previous.ilvl})` : 'Empty',
      after: item ? `${item.name} (${item.ilvl})` : 'Empty', beforeItem, afterItem }]
  })
}

/** Group-delta scoring → calibrated shortlist → loose batch → standalone detailed finalists. */
export async function runTopGear(raw: string, options: TopGearOptions, context: {
  simcPath: string; signal?: AbortSignal; onProgress?: (p: TopGearProgress) => void
}, deps: Dependencies = {}): Promise<TopGearResult> {
  const run = deps.run ?? runSim, now = deps.now ?? Date.now
  const hardware = deps.hardware ?? { threads: availableParallelism(), freeMemory: freemem() }
  const start = now(), signal = context.signal
  signal?.throwIfAborted()
  function integer(value: number, min: number, max: number, name: string): number {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`)
    return value
  }
  const budgetSeconds = integer(options.budgetSeconds, 15, 3600, 'Time budget')
  const threads = integer(options.threads ?? Math.max(1, hardware.threads - 2), 1, hardware.threads, 'Threads')
  const fightSeconds = integer(options.fightSeconds ?? 300, 30, 900, 'Fight duration')
  const targets = integer(options.targets ?? 1, 1, 20, 'Target count')
  const profile = parseAddonProfile(raw)
  if (!profile.className || !profile.spec || !profile.equipped.length) throw new Error('Paste a full SimC addon export with equipped gear and specialization.')
  // Hypothetical items are appended so ids assigned to owned gear never shift.
  const hypothetical = parseHypotheticals(profile, options.hypothetical ?? [])
  const hypotheticalItems = hypothetical.accepted.map((h) => h.candidate)
  const declarations = declarationsFrom(hypothetical.accepted)
  const all = [...profile.equipped, ...profile.bagItems, ...hypotheticalItems]
  if (!Array.isArray(options.selectedIds) || options.selectedIds.some((id) => !Number.isInteger(id) || id < 0 || id >= all.length)) throw new Error('Invalid candidate selection')
  const selectedIds = [...new Set(options.selectedIds)]
  // A declared item is always in play: the user added it in order to test it.
  const selected = [...new Set([...selectedIds.map((id) => all[id]), ...hypotheticalItems])]
  const progress = (stage: string, fraction: number, detail: string): void => context.onProgress?.({ stage, fraction: Math.max(0, Math.min(1, fraction)), detail })
  progress('Checking simc', 0, 'Verifying the installed build')
  const version = await (deps.probe ?? probeVersion)(context.simcPath, signal)
  if (!version) throw new Error('Could not identify the simc build')
  requireCompatibleSimc(profile, version)
  const binarySha256 = await (deps.fingerprint ?? sha256File)(context.simcPath, signal)
  const looseError = 0.5, tightError = 0.1
  const settings = (error: number): string => `threads=${threads}\nfight_style=Patchwerk\ndesired_targets=${targets}\nmax_time=${fightSeconds}\niterations=1000000\ntarget_error=${error}`
  // Conservative RAM allowance for simc state, not just serialized input bytes.
  const batchSize = Math.max(1, Math.floor(hardware.freeMemory * 0.05 / (1024 * 1024)))
  const memoryLimit = Math.max(1, Math.floor(hardware.freeMemory * 0.05 / (64 * 1024)))
  const warnings = new Set<string>(), rejected: TopGearResult['rejected'] = []
  async function execute(input: string, leanReport: boolean, stage: string, fraction: number): Promise<RunResult> {
    signal?.throwIfAborted()
    const result = await run({ simcPath: context.simcPath, input, leanReport, signal,
      onProgress: (p) => progress(stage, fraction, `${p.phase} · ${p.completed}/${p.total}`) })
    signal?.throwIfAborted()
    if (result.version?.build !== version!.build || result.version?.wowBuild !== version!.wowBuild) throw new Error('The simc build changed during the run; results were discarded.')
    return result
  }
  async function batch(entries: BatchEntry[], stage: string, fraction: number): Promise<{ metrics: Map<string, Metric>; scores: Map<string, number>; msPerEntry: number }> {
    const metrics = new Map<string, Metric>(), scores = new Map<string, number>()
    let elapsed = 0, measured = 0
    for (let offset = 0; offset < entries.length; offset += batchSize) {
      let active = entries.slice(offset, offset + batchSize)
      let drops = 0
      while (active.length) {
        progress(stage, fraction, `${offset + active.length} of ${entries.length} gear choices`)
        let result: RunResult
        try { result = await execute(buildBatchInput(raw, active, settings(looseError)), true, stage, fraction) }
        catch (err) {
          signal?.throwIfAborted()
          const match = String((err as { stdout?: string }).stdout ?? '').match(/Profileset '([^']+)'\s*:\s*([^\r\n]+)/)
          const failed = match && active.find((e) => e.id === match[1])
          if (!failed) throw err
          if (++drops > 12) throw new Error('Too many rejected choices in one batch. Narrow the selection and review equipment metadata.')
          rejected.push({ description: combinationOverrides({ gear: failed.gear }).join('; '), reason: match![2] })
          active = active.filter((e) => e !== failed)
          continue
        }
        const sim = (result.json as { sim?: { players?: Array<{ collected_data?: { dps?: { mean?: number } } }>; profilesets?: { results?: Metric[] } } }).sim
        const baselineDps = sim?.players?.[0]?.collected_data?.dps?.mean
        if (!Number.isFinite(baselineDps)) throw new Error('Calibration batch has no baseline DPS')
        const returned = new Map((sim?.profilesets?.results ?? []).map((r) => [r.name, r]))
        for (const entry of active) {
          const metric = returned.get(entry.id)
          if (!metric || !Number.isFinite(metric.mean) || !Number.isFinite(metric.mean_error)) throw new Error(`Missing or invalid result for ${entry.id}`)
          metrics.set(entry.id, metric)
          scores.set(entry.id, metric.mean - baselineDps!)
        }
        elapsed += result.durationMs
        measured += active.length
        break
      }
    }
    return { metrics, scores, msPerEntry: Math.max(1, elapsed / Math.max(1, measured)) }
  }
  const groupScores = new Map<string, number | null>()
  let baseline: SimReport | undefined
  let calibrated = { size: 1, finalists: 1 }, msPerCombination = 1, detailMs = 1
  const solve = (minimumSize: number) => solveTopGear(profile, {
    selected, ilvlFloor: 0, shortlistSize: minimumSize, scoreItem: () => 0, signal,
    maxRetainedPaths: memoryLimit,
    hypothetical: hypotheticalItems,
    // Enforces the two-embellishment cap. Declared flags win over the
    // crafted-epic proxy.
    restrictions: restrictionsWith(declarations),
    // Weapon subclass eligibility, from derived class proficiency.
    // The spec rules say whether a two-hander is allowed; this says which kind,
    // so a shadow priest is offered a staff and not a two-handed sword.
    eligibility: (candidate) => {
      const meta = lookupItem(candidate.item.id)
      if (!meta) return true // unknown to the table — simc decides, as before
      const proficient = canWieldWeapon(profile.className, meta.itemClassId, meta.itemSubclassId)
      if (proficient !== true) return proficient
      // Class proficiency is the outer bound; the spec is usually narrower. A
      // death knight may wield a one-handed sword, but Blood never does.
      const specRules = rulesFor(profile)
      if (!specRules?.mainHand || meta.itemClassId !== 2) return true
      return specRules.mainHand.includes(meta.itemSubclassId)
    },
    restrictionsAreApproximate: true,
    scoreGroups: async (groups) => {
      if (!baseline) {
        const unique = new Map(groups.flat().map((gear) => [gearKey(gear), gear]))
        const entries = [...unique.values()].map((gear, i) => ({ id: `g${i}`, gear }))
        const scored = await batch(entries, 'Measuring selected gear', 0.12)
        entries.forEach((entry) => groupScores.set(gearKey(entry.gear), scored.scores.get(entry.id) ?? null))
        msPerCombination = scored.msPerEntry
        progress('Simulating equipped gear', 0.35, 'Building the detailed baseline report')
        const baseRun = await execute(`${raw.trimEnd()}\n${settings(tightError)}\n`, false, 'Simulating equipped gear', 0.35)
        baseline = extractReport(baseRun.json) ?? undefined
        if (!baseline || baseline.dps.mean <= 0) throw new Error('Baseline returned no usable DPS report')
        detailMs = Math.max(1, baseRun.durationMs)
        calibrated = planShortlist(budgetSeconds * 1000 - (now() - start), msPerCombination, detailMs, Math.max(1, Math.floor(memoryLimit / 16)))
      }
      progress('Choosing combinations', 0.45, 'Protecting tier-set options in the shortlist')
      return { scores: groups.map((g) => g.map((gear) => groupScores.get(gearKey(gear)) ?? null)), shortlistSize: Math.max(minimumSize, calibrated.size) }
    }
  })
  let solved
  try { solved = await solve(1) }
  catch (err) {
    const minimum = (err as Error).message.match(/shortlistSize must be at least (\d+)/)
    if (!minimum) throw err
    warnings.add('The shortlist was expanded to preserve every reachable tier bonus; the time budget is approximate.')
    solved = await solve(Number(minimum[1]))
  }
  if (!baseline || !solved.shortlist.length) throw new Error('No supported combinations remain. Review the selection and item metadata.')
  solved.warnings.forEach((w) => warnings.add(w))
  solved.excluded.forEach((e) => rejected.push({ description: `${e.item.name} (${e.item.ilvl})`, reason: e.reason }))
  progress('Comparing combinations', 0.55, `${solved.shortlist.length} shortlisted combinations`)
  const entries = solved.shortlist.map((combo, i) => ({ id: `c${i}`, gear: combo.gear }))
  const stageOne = await batch(entries, 'Comparing combinations', 0.55)
  const finalists = [...stageOne.metrics.values()].sort((a, b) => b.mean - a.mean).slice(0, calibrated.finalists)
  const ranking: RankedCombination[] = []
  let detailedSimulated = 0
  for (let i = 0; i < finalists.length; i++) {
    if (ranking.length && now() - start >= budgetSeconds * 1000) { warnings.add('The time budget was reached; remaining detailed reruns were skipped.'); break }
    const metric = finalists[i]
    const combo = solved.shortlist[Number(metric.name.slice(1))]
    progress('Refining top results', 0.7 + 0.28 * i / finalists.length, `${i + 1} of ${finalists.length} detailed reports`)
    const overrides = combinationOverrides(combo)
    const changes = gearDifferences(profile, combo.gear)
    let report = baseline, durationMs = detailMs
    if (changes.length) {
      let result: RunResult
      try { result = await execute(`${raw.trimEnd()}\n${overrides.join('\n')}\n${settings(tightError)}\n`, false, 'Refining top results', 0.7 + 0.28 * i / finalists.length) }
      catch (err) {
        signal?.throwIfAborted()
        rejected.push({ description: metric.name, reason: (err as Error).message })
        continue
      }
      const extracted = extractReport(result.json)
      if (!extracted || extracted.dps.mean <= 0) throw new Error(`No detailed report for ${metric.name}`)
      report = extracted; durationMs = result.durationMs; detailedSimulated++
    }
    const delta = report.dps.mean - baseline.dps.mean
    ranking.push({ id: metric.name, dps: report.dps.mean, error: report.dps.error, delta,
      deltaPct: delta / baseline.dps.mean * 100, report, durationMs,
      changes, overrides, tier: combo.tier, reusedBaseline: changes.length === 0 })
  }
  if (!ranking.length) throw new Error('No detailed finalist completed successfully')
  ranking.sort((a, b) => b.dps - a.dps)
  if (rejected.length) warnings.add(`${rejected.length} choices were excluded or rejected; see the run details.`)
  if (now() - start > budgetSeconds * 1000) warnings.add('Preparation and minimum verification exceeded the requested time budget.')
  const table = itemTable()
  if (await (deps.fingerprint ?? sha256File)(context.simcPath, signal) !== binarySha256) throw new Error('The simc binary changed during the run; results were discarded.')
  progress('Complete', 1, `${ranking.length} detailed reports ready`)
  return { baseline, baselineDurationMs: detailMs, ranking, warnings: [...warnings], rejected, combinationCount: solved.combinationCount.toString(),
    shortlisted: solved.shortlist.length, stageOneSimulated: stageOne.metrics.size, detailedSimulated,
    durationMs: now() - start, version, binarySha256, metadata: { version: table.version, generated: table.generated, namespace: table.namespace },
    settings: { budgetSeconds, threads, fightSeconds, targets, looseError, tightError, estimatedMsPerCombination: msPerCombination }, input: raw, selectedIds,
    hypotheticalRejected: hypothetical.rejected,
    schemaVersion: 2, options: structuredClone(options),
    hypotheticalAccepted: hypothetical.accepted.map((h) => ({
      name: h.candidate.name, slot: h.candidate.slotClass,
      itemString: emitItemString(h.candidate.item), embellished: h.embellished, ilvl: h.candidate.ilvl || undefined
    })) }
}
