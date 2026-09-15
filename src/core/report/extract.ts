/**
 * Turns simc's JSON into a typed report.
 *
 * Field choices here are measured, not guessed:
 *  - Damage breakdown uses `compound_amount`, which sums exactly to
 *    `collected_data.dmg.mean`. `actual_amount` excludes child effects and
 *    `portion_amount` sums to ~0.55 — both produce a broken breakdown.
 *  - There is no per-iteration DPS distribution in the JSON at any
 *    statistics_level, so no histogram is offered.
 */

export interface AbilityRow {
  name: string
  /** Total damage including child effects. */
  amount: number
  /** Share of total damage, 0..1. Sums to 1 across rows. */
  share: number
  executes: number
  school?: string
}

export interface BuffRow {
  name: string
  /** Percent of fight time the buff was up, 0..100 as simc reports it. */
  uptime: number
  /** simc's "benefit" measure, 0..100. */
  benefit: number
  startCount: number
}

export interface GearRow {
  id?: number
  slot: string
  name: string
  ilvl: number
  /**
   * Per-item stats exactly as simc parsed them. simc already computes
   * these for every equipped item; extraction used to discard them, so hover
   * detail cost nothing new to restore.
   */
  stats?: Array<{ name: string; value: number }>
  /** simc's own round-trip of the item string. */
  encoded?: string
}

/** Keys on a gear entry that are metadata rather than stats. */
const NON_STAT_KEYS = new Set(['name', 'encoded_item', 'ilevel'])

/** `crit_rating` -> `Crit Rating`; `agiint` -> `Agi/Int`. */
function statLabel(key: string): string {
  return key === 'agiint' ? 'Agi/Int' : humanise(key)
}

export interface SimReport {
  character: {
    name: string
    race?: string
    level?: number
    spec?: string
    className?: string
  }
  dps: {
    mean: number
    error: number
    min: number
    max: number
    median: number
    stdDev: number
    /** error as a percentage of mean. */
    errorPct: number
  }
  fightLength: number
  totalDamage: number
  abilities: AbilityRow[]
  buffs: BuffRow[]
  gear: GearRow[]
  iterations: number
}

interface RawStat {
  name?: string
  type?: string
  school?: string
  compound_amount?: number
  num_executes?: { mean?: number }
}

interface RawBuff {
  name?: string
  uptime?: number
  benefit?: number
  start_count?: number
}

interface RawPlayer {
  name?: string
  race?: string
  level?: number
  specialization?: string
  talents?: unknown
  stats?: RawStat[]
  buffs?: RawBuff[]
  gear?: Record<string, Record<string, unknown> & { name?: string; ilevel?: number; encoded_item?: string }>
  collected_data?: {
    dmg?: { mean?: number }
    fight_length?: { mean?: number }
    dps?: {
      mean?: number
      min?: number
      max?: number
      median?: number
      std_dev?: number
      mean_std_dev?: number
      count?: number
    }
  }
}

/** `elemental_blast` -> `Elemental Blast` */
export function humanise(id: string): string {
  return id
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function extractReport(json: unknown): SimReport | null {
  const sim = (json as { sim?: { players?: RawPlayer[] } })?.sim
  const p = sim?.players?.[0]
  if (!p) return null

  const cd = p.collected_data ?? {}
  const dps = cd.dps ?? {}
  const mean = dps.mean ?? 0
  const error = dps.mean_std_dev ?? 0
  const totalDamage = cd.dmg?.mean ?? 0

  const abilities: AbilityRow[] = (p.stats ?? [])
    .filter((s) => s.type === 'damage' && (s.compound_amount ?? 0) > 0)
    .map((s) => ({
      name: humanise(s.name ?? 'unknown'),
      amount: s.compound_amount ?? 0,
      share: totalDamage > 0 ? (s.compound_amount ?? 0) / totalDamage : 0,
      executes: s.num_executes?.mean ?? 0,
      school: s.school
    }))
    .sort((a, b) => b.amount - a.amount)

  const buffs: BuffRow[] = (p.buffs ?? [])
    .filter((b) => (b.uptime ?? 0) > 0)
    .map((b) => ({
      name: humanise(b.name ?? 'unknown'),
      uptime: b.uptime ?? 0,
      benefit: b.benefit ?? 0,
      startCount: b.start_count ?? 0
    }))
    .sort((a, b) => b.uptime - a.uptime)

  const gear: GearRow[] = Object.entries(p.gear ?? {})
    .map(([slot, item]) => ({
      slot: humanise(slot),
      name: humanise(item?.name ?? ''),
      id: Number(item?.encoded_item?.match(/(?:^|,)id=(\d+)/)?.[1]) || undefined,
      ilvl: item?.ilevel ?? 0,
      encoded: item?.encoded_item,
      stats: Object.entries(item ?? {})
        .filter(([k, v]) => !NON_STAT_KEYS.has(k) && typeof v === 'number' && v !== 0)
        .map(([k, v]) => ({ name: statLabel(k), value: v as number }))
        .sort((a, b) => b.value - a.value)
    }))
    .sort((a, b) => b.ilvl - a.ilvl)

  return {
    character: {
      name: p.name ?? 'Unknown',
      race: p.race,
      level: p.level,
      spec: p.specialization
    },
    dps: {
      mean,
      error,
      min: dps.min ?? 0,
      max: dps.max ?? 0,
      median: dps.median ?? 0,
      stdDev: dps.std_dev ?? 0,
      errorPct: mean > 0 ? (error / mean) * 100 : 0
    },
    fightLength: cd.fight_length?.mean ?? 0,
    totalDamage,
    abilities,
    buffs,
    gear,
    iterations: dps.count ?? 0
  }
}
