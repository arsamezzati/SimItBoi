import { setImmediate } from 'node:timers/promises'
import type { CandidateItem, Profile, SlotClass } from '../types.ts'
import { SLOT_CLASSES, PAIRED_SLOTS } from '../types.ts'
import { emitItemString } from '../parser/addonProfile.ts'
import { lookupItem, isArmorCompatible, isCrafted, type ItemMeta } from '../data/itemTable.ts'
import { resolveUniqueRule, type UniqueRule } from '../data/unique.ts'

/**
 * Unique rule for a candidate under the supplied metadata, including the
 * crafted-epic and ring/trinket domain rules. Takes `meta` rather than calling the global table so
 * `opts.lookup` injection keeps working.
 */
const resolvedUnique = (item: CandidateItem, meta: ItemMeta): UniqueRule | undefined => {
  const rule = resolveUniqueRule(meta.unique, {
    quality: meta.quality,
    inventoryType: meta.inventoryType,
    crafted: isCrafted(item.item)
  })
  // Only a paired slot can hold two of anything. Elsewhere an unknown rule is
  // unviolatable, so it is not a constraint and must not fail the item.
  if (rule.kind === 'unknown' && !PAIRED_SLOTS.includes(item.slotClass)) return undefined
  return rule
}
import { allowedConfigs, inferConfig, isLegalPair, rulesFor, type SpecRules } from './weapons.ts'

export type Gear = Readonly<Record<string, CandidateItem | null>>
/**
 * A category an item consumes, how many of it the game allows, and how many
 * units this one item consumes. `uses` defaults to one; it is greater when a
 * single item carries several members of the same category, e.g. two gems.
 */
export interface CategoryLimit { key: string; limit: number; uses?: number }
export interface EquipmentRestrictions {
  /** All extra cross-item categories, including those outside rings/trinkets. */
  categories: readonly CategoryLimit[]
  /** Count contributed by this exact bonus-ID variant, not just its base ID. */
  embellishments: number
}
export interface SolverOptions {
  /** Required: M7 derives this from measured throughput and the user's budget. */
  shortlistSize: number
  /** Additive heuristic only; callers must not present this value as simulated DPS. */
  scoreItem: (item: CandidateItem) => number
  /** Optional paired weapon score, when M5 cannot measure a legal single swap. */
  scoreWeapons?: (gear: Gear) => number
  /** M7 scores complete slot groups with real profilesets; null rejects a failed choice. */
  scoreGroups?: (groups: readonly (readonly Gear[])[]) => Promise<{ scores: readonly (readonly (number | null)[])[]; shortlistSize?: number }>
  ilvlFloor?: number
  /** Physical candidate entries from this profile. Equipped gear is always included. */
  selected?: readonly CandidateItem[]
  lookup?: (id: number) => ItemMeta | undefined
  rules?: SpecRules
  /** Class/spec/subclass eligibility; undefined means unknown and rejects the placement. */
  eligibility?: (item: CandidateItem, slot: string) => boolean | undefined
  restrictions?: (item: CandidateItem) => EquipmentRestrictions | undefined
  /**
   * Set when `restrictions` is derived rather than measured, so the run is
   * still reported as provisional — embellishment detection is a
   * proxy, not a measurement.
   */
  restrictionsAreApproximate?: boolean
  /**
   * Candidates the user declared but does not own. Passing an item here
   * is what makes it acceptable to `selected`; nothing else bypasses the guard.
   */
  hypothetical?: readonly CandidateItem[]
  /** Fail rather than emit a provisional result with metadata coverage warnings. */
  requireVerified?: boolean
  maxStates?: number
  maxRetainedPaths?: number
  maxGroupChoices?: number
  signal?: AbortSignal
  onProgress?: (completedGroups: number, totalGroups: number) => void
}
export interface Combination {
  key: string
  gear: Gear
  score: number
  /** Per-set bonus breakpoints. Different sets are never added together. */
  tier: Readonly<Record<string, 0 | 2 | 4>>
}
export interface SolverResult {
  shortlist: Combination[]
  /** Exact count under the supplied constraints and candidate filters, not a DPS search count. */
  combinationCount: bigint
  buckets: Array<{ tier: Readonly<Record<string, 0 | 2 | 4>>; count: bigint }>
  excluded: Array<{ item: CandidateItem; reason: string }>
  warnings: string[]
  validation: 'verified' | 'provisional'
  peakStates: number
}
interface Entry {
  item: CandidateItem
  meta: ItemMeta
  identity: string
  constraints: CategoryLimit[]
  embellishments: number
}
interface Choice { gear: Gear; score: number; entries: Entry[]; key: string }
interface State {
  tiers: Record<string, number>
  counts: Record<string, number>
  count: bigint
  paths: Array<{ gear: Gear; score: number; key: string }>
}

const INVENTORY_SLOT: Record<string, SlotClass> = {
  HEAD: 'head', NECK: 'neck', SHOULDER: 'shoulder', CLOAK: 'back', CHEST: 'chest', ROBE: 'chest',
  WRIST: 'wrist', HAND: 'hands', WAIST: 'waist', LEGS: 'legs', FEET: 'feet', FINGER: 'finger', TRINKET: 'trinket'
}
function canonical(values: Record<string, unknown>): string {
  return JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))
}
export function gearKey(gear: Gear): string {
  return canonical(Object.fromEntries(Object.entries(gear).map(([slot, c]) => [slot, c ? emitItemString(c.item, slot) : null])))
}
function positiveInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}
function finite(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Every candidate needs a finite heuristic score')
  return value
}
function constraint(rule: UniqueRule | undefined, id: number): CategoryLimit[] {
  if (!rule || rule.kind === 'none') return []
  if (rule.kind === 'unknown') throw new Error(`Unknown restriction for item ${id}`)
  return [{ key: rule.kind === 'item' ? `item:${id}` : `category:${rule.category}`, limit: positiveInt(rule.limit, 'unique limit') }]
}
function compare(a: { score: number; key: string }, b: { score: number; key: string }): number {
  return b.score - a.score || a.key.localeCompare(b.key)
}
function retain<T extends { score: number; key: string }>(paths: T[], path: T, k: number): void {
  if (paths.length === k && compare(path, paths[paths.length - 1]) >= 0) return
  let lo = 0, hi = paths.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compare(paths[mid], path) <= 0) lo = mid + 1
    else hi = mid
  }
  paths.splice(lo, 0, path)
  if (paths.length > k) paths.pop()
}

/**
 * Exact top-K for an additive heuristic, partitioned by tier breakpoints.
 * Dynamic-programming states contain only constraints that affect future choices.
 * Retaining K paths per identical state is safe: every continuation adds the same
 * score and obeys the same constraints. BigInt counts include discarded paths.
 */
export async function solveTopGear(profile: Profile, opts: SolverOptions): Promise<SolverResult> {
  let k = positiveInt(opts.shortlistSize, 'shortlistSize')
  const maxStates = positiveInt(opts.maxStates ?? 20_000, 'maxStates')
  const maxPaths = positiveInt(opts.maxRetainedPaths ?? 200_000, 'maxRetainedPaths')
  const maxChoices = positiveInt(opts.maxGroupChoices ?? 100_000, 'maxGroupChoices')
  opts.signal?.throwIfAborted()
  const lookup = opts.lookup ?? lookupItem
  const rules = opts.rules ?? rulesFor(profile)
  if (!rules) throw new Error(`No weapon rules for ${profile.className}:${profile.spec}`)
  const warnings = new Set<string>()
  if (!rules.verified) warnings.add('Weapon eligibility rules have not been verified for this game build.')
  if (!opts.restrictions) warnings.add('Cross-item categories and embellishment coverage are unverified; only bundled per-item restrictions are enforced.')
  // Embellishments are measured from the game's own marker and category
  // membership now ships, so both bind. What stays unverified is the
  // *coverage* of that membership: only current-content items carry a category.
  else if (opts.restrictionsAreApproximate) warnings.add('Category limits are enforced from bundled membership, which covers current content only, so a set mixing older items of one limited category may not be caught. Embellishment counts are read from item data and are exact.')
  if (!opts.eligibility) warnings.add('Weapon subclass and class-specific item restrictions are not fully represented in the bundled metadata.')
  if (opts.requireVerified && warnings.size) throw new Error([...warnings].join(' '))
  // Owned gear, plus items the user explicitly declared. Anything else
  // is still refused: the guard distinguishes a declaration from stray input.
  const owned = new Set([...profile.equipped, ...profile.bagItems, ...(opts.hypothetical ?? [])])
  if (opts.selected?.some((c) => !owned.has(c))) {
    throw new Error('Selected items must be owned entries from this profile, or declared hypothetical items')
  }
  const equipped = new Set(profile.equipped)
  const equippedLevels = profile.equipped.map((c) => c.ilvl).filter((n) => n > 0)
  const floor = opts.ilvlFloor ?? (equippedLevels.length ? Math.min(...equippedLevels) - 30 : 0)
  if (!Number.isFinite(floor)) throw new Error('ilvlFloor must be finite')
  const excluded: SolverResult['excluded'] = []
  const entries: Entry[] = []
  for (const item of new Set([...profile.equipped, ...(opts.selected ?? profile.bagItems)])) {
    let reason: string | undefined
    const meta = lookup(item.item.id)
    if (!equipped.has(item) && item.source !== 'hypothetical' && item.ilvl < floor) reason = 'Below item-level floor'
    else if (!meta) reason = 'Missing item metadata'
    else if (!isArmorCompatible(profile.className, meta)) reason = 'Wrong armor class'
    else if (!meta.weaponType && INVENTORY_SLOT[meta.inventoryType] !== item.slotClass) reason = 'Item inventory type does not match slot'
    else if (meta.weaponType && !['main_hand', 'off_hand'].includes(item.slotClass)) reason = 'Weapon is assigned to a non-weapon slot'
    // Only paired slots can hold two of anything, so an unknown rule elsewhere
    // can never be violated and must not exclude the item.
    else if (resolvedUnique(item, meta)?.kind === 'unknown') reason = 'Unknown unique restriction'
    else if (!meta.weaponType && opts.eligibility && opts.eligibility(item, item.slotClass) !== true) reason = 'Item eligibility rejected or unknown'
    const extra = !reason ? opts.restrictions?.(item) : undefined
    if (!reason && opts.restrictions && !extra) reason = 'Missing variant equipment restrictions'
    if (reason || !meta) { excluded.push({ item, reason: reason ?? 'Missing metadata' }); continue }
    if (extra && (!Number.isSafeInteger(extra.embellishments) || extra.embellishments < 0)) throw new Error('Invalid embellishment count')
    const constraints = constraint(resolvedUnique(item, meta), item.item.id)
    for (const category of extra?.categories ?? []) {
      if (!category.key) throw new Error('Category keys cannot be empty')
      constraints.push({ key: `category:${category.key}`, limit: positiveInt(category.limit, 'category limit'), uses: positiveInt(category.uses ?? 1, 'category uses') })
    }
    // The same restriction can arrive from two sources — an item's unique rule
    // and its own category membership — and must still count once, so these
    // take the larger usage rather than adding them. Several members of one
    // category inside a single item already arrive as one entry with uses > 1.
    const mergedLimit = new Map<string, number>()
    const mergedUses = new Map<string, number>()
    for (const c of constraints) {
      mergedLimit.set(c.key, Math.min(mergedLimit.get(c.key) ?? Infinity, c.limit))
      mergedUses.set(c.key, Math.max(mergedUses.get(c.key) ?? 0, positiveInt(c.uses ?? 1, 'category uses')))
    }
    entries.push({ item, meta, identity: emitItemString(item.item, 'item'),
      constraints: [...mergedLimit].map(([key, limit]) => ({ key, limit, uses: mergedUses.get(key) ?? 1 })),
      embellishments: extra?.embellishments ?? 0 })
  }
  const limits: Record<string, number> = { embellishments: 2 }
  for (const e of entries) for (const c of e.constraints) limits[c.key] = Math.min(limits[c.key] ?? Infinity, c.limit)
  const tierIds = [...new Set(entries.flatMap((e) => e.meta.setId === undefined ? [] : [String(e.meta.setId)]))].sort()
  const groups: Choice[][] = []
  let stepsForChoices = 0
  function choice(placements: Array<[string, Entry | null]>, weapons = false): Choice {
    const gear = Object.fromEntries(placements.map(([slot, e]) => [slot, e?.item ?? null]))
    const score = weapons && opts.scoreWeapons ? opts.scoreWeapons(gear)
      : placements.reduce((sum, [, e]) => sum + (e ? finite(opts.scoreItem(e.item)) : 0), 0)
    return { gear, score: finite(score), entries: placements.flatMap(([, e]) => e ? [e] : []), key: gearKey(gear) }
  }
  function addGroup(choices: Choice[], name: string): void {
    const distinct = [...new Map(choices.map((c) => [c.key, c])).values()].sort(compare)
    if (!distinct.length) throw new Error(`No supported equipment choices for ${name}`)
    groups.push(distinct)
  }
  function append(choices: Choice[], value: Choice): void {
    if (choices.length >= maxChoices) throw new Error('Combination search exceeded maxGroupChoices; narrow the candidate selection')
    choices.push(value)
  }
  for (const slot of SLOT_CLASSES.filter((s) => s !== 'main_hand' && s !== 'off_hand')) {
    const candidates = entries.filter((e) => e.item.slotClass === slot)
    const paired = slot === 'finger' || slot === 'trinket'
    if (!candidates.length) {
      if (profile.equipped.some((c) => c.slotClass === slot)) throw new Error(`Equipped ${slot} has no supported metadata`)
      addGroup([choice(paired ? [[`${slot}1`, null], [`${slot}2`, null]] : [[slot, null]])], slot)
    } else if (!paired) {
      const choices: Choice[] = []
      for (const e of candidates) append(choices, choice([[slot, e]]))
      addGroup(choices, slot)
    } else if (candidates.length === 1) {
      addGroup([choice([[`${slot}1`, candidates[0]], [`${slot}2`, null]])], slot)
    } else {
      const choices: Choice[] = []
      for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
        const [a, b] = [candidates[i], candidates[j]].sort((x, y) => x.identity.localeCompare(y.identity))
        append(choices, choice([[`${slot}1`, a], [`${slot}2`, b]]))
        if (++stepsForChoices % 2048 === 0) { await setImmediate(); opts.signal?.throwIfAborted() }
      }
      addGroup(choices, slot)
    }
  }
  const configs = allowedConfigs(profile, inferConfig(profile, (c) => lookup(c.item.id)?.weaponType), rules)
  const weapons = entries.filter((e) => e.meta.weaponType)
  const weaponChoices: Choice[] = []
  for (const config of configs) for (const mh of weapons) {
    const offHands = config === 'two_hand' || config === 'ranged' ? [null] : weapons
    for (const oh of offHands) {
      if (++stepsForChoices % 2048 === 0) { await setImmediate(); opts.signal?.throwIfAborted() }
      if (mh === oh || !isLegalPair(config, mh.meta.weaponType, oh?.meta.weaponType, rules)) continue
      if (opts.eligibility && (opts.eligibility(mh.item, 'main_hand') !== true || (oh && opts.eligibility(oh.item, 'off_hand') !== true))) continue
      append(weaponChoices, choice([['main_hand', mh], ['off_hand', oh]], true))
    }
  }
  addGroup(weaponChoices, 'weapons')
  // Reject locally impossible pairs before asking simc to measure them.
  for (let i = 0; i < groups.length; i++) {
    groups[i] = groups[i].filter((choice) => {
      const counts: Record<string, number> = {}
      for (const e of choice.entries) {
        for (const c of e.constraints) counts[c.key] = (counts[c.key] ?? 0) + (c.uses ?? 1)
        counts.embellishments = (counts.embellishments ?? 0) + e.embellishments
      }
      return Object.entries(counts).every(([key, count]) => count <= limits[key])
    })
  }
  if (opts.scoreGroups) {
    const scored = await opts.scoreGroups(groups.map((g) => g.map((c) => c.gear)))
    opts.signal?.throwIfAborted()
    if (scored.shortlistSize !== undefined) k = positiveInt(scored.shortlistSize, 'shortlistSize')
    if (scored.scores.length !== groups.length) throw new Error('Missing group scores')
    for (let i = 0; i < groups.length; i++) {
      if (scored.scores[i].length !== groups[i].length) throw new Error('Missing choice scores')
      groups[i] = groups[i].flatMap((c, j) => {
        const score = scored.scores[i][j]
        return score === null ? [] : [{ ...c, score: finite(score) }]
      })
    }
  }
  // Category counts cease to affect future choices after their final group.
  const lastGroup: Record<string, number> = {}
  groups.forEach((choices, i) => choices.forEach((c) => c.entries.forEach((e) => {
    for (const constraint of e.constraints) lastGroup[constraint.key] = i
    if (e.embellishments) lastGroup.embellishments = i
  })))
  let states = new Map<string, State>([['', { tiers: {}, counts: {}, count: 1n, paths: [{ gear: {}, score: 0, key: '' }] }]])
  let peakStates = 1, steps = 0
  for (let index = 0; index < groups.length; index++) {
    const next = new Map<string, State>()
    let retainedPaths = 0
    for (const state of states.values()) for (const c of groups[index]) {
      if (++steps % 2048 === 0) { await setImmediate(); opts.signal?.throwIfAborted() }
      const counts = { ...state.counts }, tiers = { ...state.tiers }
      for (const e of c.entries) {
        for (const constraint of e.constraints) counts[constraint.key] = (counts[constraint.key] ?? 0) + (constraint.uses ?? 1)
        if (e.embellishments) counts.embellishments = (counts.embellishments ?? 0) + e.embellishments
        if (e.meta.setId !== undefined) tiers[e.meta.setId] = Math.min(4, (tiers[e.meta.setId] ?? 0) + 1)
      }
      if (Object.entries(counts).some(([key, count]) => count > limits[key])) continue
      for (const key of Object.keys(counts)) if (lastGroup[key] <= index) delete counts[key]
      const stateKey = canonical(tiers) + canonical(counts)
      let dest = next.get(stateKey)
      if (!dest) {
        dest = { tiers, counts, count: 0n, paths: [] }
        next.set(stateKey, dest)
        if (next.size > maxStates) throw new Error('Combination search exceeded maxStates; narrow the candidate selection')
      }
      dest.count += state.count
      const previousLength = dest.paths.length
      for (const path of state.paths) {
        const score = finite(path.score + c.score)
        if (dest.paths.length === k && score < dest.paths[k - 1].score) continue
        const gear = { ...path.gear, ...c.gear }
        retain(dest.paths, { gear, score, key: gearKey(gear) }, k)
      }
      retainedPaths += dest.paths.length - previousLength
      if (retainedPaths > maxPaths) throw new Error('Combination search exceeded maxRetainedPaths; reduce shortlist size or candidate selection')
    }
    states = next
    peakStates = Math.max(peakStates, states.size)
    opts.onProgress?.(index + 1, groups.length)
    await setImmediate()
    opts.signal?.throwIfAborted()
  }
  const buckets = new Map<string, { tier: Record<string, 0 | 2 | 4>; count: bigint; paths: Combination[] }>()
  for (const state of states.values()) {
    const tier = Object.fromEntries(tierIds.map((id) => [id, (state.tiers[id] ?? 0) >= 4 ? 4 : (state.tiers[id] ?? 0) >= 2 ? 2 : 0])) as Record<string, 0 | 2 | 4>
    const key = canonical(tier)
    let bucket = buckets.get(key)
    if (!bucket) { bucket = { tier, count: 0n, paths: [] }; buckets.set(key, bucket) }
    bucket.count += state.count
    for (const path of state.paths) retain(bucket.paths, { ...path, tier }, k)
  }
  if (buckets.size > k) throw new Error(`shortlistSize must be at least ${buckets.size} to preserve every reachable tier bucket`)
  const selected = [...buckets.values()].map((b) => b.paths[0])
  const rest = [...buckets.values()].flatMap((b) => b.paths.slice(1)).sort(compare)
  selected.push(...rest.slice(0, k - selected.length))
  return {
    shortlist: selected.sort(compare), combinationCount: [...buckets.values()].reduce((n, b) => n + b.count, 0n),
    buckets: [...buckets.values()].map(({ tier, count }) => ({ tier, count })), excluded,
    warnings: [...warnings], validation: warnings.size ? 'provisional' : 'verified', peakStates
  }
}

/** Explicitly clear empty slots so swapping from 1H+shield to 2H cannot retain the shield. */
export function combinationOverrides(combo: Pick<Combination, 'gear'>): string[] {
  return Object.entries(combo.gear).map(([slot, item]) => item ? emitItemString(item.item, slot) : `${slot}=none`)
}
