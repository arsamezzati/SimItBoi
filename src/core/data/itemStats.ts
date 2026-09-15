/**
 * Per-item stat probe.
 *
 * simc parses an item string into real stats and reports them under
 * `sim.players[0].gear.<slot>` — but only for *equipped* items, and profileset
 * results carry statistics only, so a batch cannot return them.
 *
 * The trick is that one run reports every slot at once. Packing one candidate
 * per slot turns N candidates into roughly N/15 runs instead of N, which is what
 * makes showing real stats for a whole bag affordable.
 *
 * Runs use `iterations=1` and a one-second fight: nothing here depends on the
 * simulation result, only on simc's parse of the gear.
 */
import type { CandidateItem, Profile, SlotClass } from '../types.ts'
import { emitItemString } from '../parser/addonProfile.ts'
import { runSim, type RunOptions, type RunResult } from '../simc/runner.ts'

export interface ItemStat {
  name: string
  value: number
}

/**
 * Probe state keyed by the exact ordered item tokens at one requested placement.
 * Candidate indexes remain the separate physical-copy identity used by Top Gear.
 */
export type ItemStatState =
  | { status: 'pending' }
  | { status: 'available'; stats: ItemStat[]; ilvl?: number }
  | { status: 'missing'; reason: string }
  | { status: 'failed'; reason: string }
export type ItemStatMap = Map<string, ItemStatState>

const NON_STAT_KEYS = new Set(['name', 'encoded_item', 'ilevel'])

function statLabel(key: string): string {
  if (key === 'agiint') return 'Agi/Int'
  return key
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** The simc input slot for a candidate; paired slots go to position 1. */
function slotFor(slot: SlotClass): string {
  if (slot === 'finger') return 'finger1'
  if (slot === 'trinket') return 'trinket1'
  return slot
}

/** Full token-preserving request/result identity, including placement. */
export function itemStatKey(candidate: CandidateItem): string {
  return emitItemString(candidate.item, slotFor(candidate.slotClass))
}

/** simc JSON pluralises only these two equipment keys. */
function reportSlotFor(slot: SlotClass): string {
  if (slot === 'shoulder') return 'shoulders'
  if (slot === 'wrist') return 'wrists'
  return slotFor(slot)
}

/**
 * Packs candidates into rounds where each round holds at most one item per
 * slot, so a single run can report all of them.
 */
export function packBySlot(candidates: readonly CandidateItem[]): CandidateItem[][] {
  const rounds: CandidateItem[][] = []
  const used: Array<Set<string>> = []
  for (const c of candidates) {
    const slot = slotFor(c.slotClass)
    let i = 0
    while (i < rounds.length && used[i].has(slot)) i++
    if (i === rounds.length) {
      rounds.push([])
      used.push(new Set())
    }
    rounds[i].push(c)
    used[i].add(slot)
  }
  return rounds
}

interface ProbeJson {
  sim?: {
    players?: Array<{
      gear?: Record<string, Record<string, unknown> & { encoded_item?: string }>
    }>
  }
}

export interface ProbeOptions {
  simcPath: string
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
  /** Test seam; production uses runSim. */
  run?: (opts: RunOptions) => Promise<RunResult>
}

/**
 * Reads real stats for every candidate.
 *
 * A round that simc refuses — an item the character cannot equip aborts the
 * whole run — is skipped rather than failing the probe. Stats are a
 * display nicety; losing some must never block the UI.
 */
export async function probeItemStats(
  profile: Profile,
  candidates: readonly CandidateItem[],
  opts: ProbeOptions
): Promise<ItemStatMap> {
  const stats: ItemStatMap = new Map(candidates.map((candidate) => [itemStatKey(candidate), { status: 'pending' }]))
  const rounds = packBySlot(candidates)

  for (const [index, round] of rounds.entries()) {
    opts.signal?.throwIfAborted()
    const lines = [profile.raw.trimEnd(), '', 'iterations=1', 'max_time=1', 'threads=1', '']
    for (const c of round) lines.push(emitItemString(c.item, slotFor(c.slotClass)))

    try {
      const run = await (opts.run ?? runSim)({
        simcPath: opts.simcPath,
        input: `${lines.join('\n')}\n`,
        leanReport: true, // keeps player.gear, drops everything else
        signal: opts.signal
      })
      const gear = (run.json as ProbeJson).sim?.players?.[0]?.gear ?? {}
      for (const candidate of round) {
        const key = itemStatKey(candidate)
        const requestedSlot = reportSlotFor(candidate.slotClass)
        const entry = gear[requestedSlot]
        if (!entry) {
          stats.set(key, { status: 'missing', reason: `simc returned no ${requestedSlot} item` })
          continue
        }
        const id = Number(entry?.encoded_item?.match(/(?:^|,)id=(\d+)/)?.[1])
        if (id !== candidate.item.id) {
          stats.set(key, { status: 'missing', reason: `simc returned a different item in ${requestedSlot}` })
          continue
        }
        stats.set(
          key,
          { status: 'available', ...(typeof entry.ilevel === 'number' ? { ilvl: entry.ilevel } : {}), stats: Object.entries(entry)
            .filter(([k, v]) => !NON_STAT_KEYS.has(k) && typeof v === 'number' && v !== 0)
            .map(([k, v]) => ({ name: statLabel(k), value: v as number }))
            .sort((a, b) => b.value - a.value)
          }
        )
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      // One unequippable item aborts its whole round. Preserve that
      // distinction instead of making failure look like unrequested data.
      for (const candidate of round) {
        stats.set(itemStatKey(candidate), { status: 'failed', reason: (err as Error).message || 'simc rejected this packed round' })
      }
    }
    opts.onProgress?.(index + 1, rounds.length)
  }

  return stats
}
