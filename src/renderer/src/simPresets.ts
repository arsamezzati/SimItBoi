/**
 * Fight length and search time are two different things that were both
 * expressed in minutes, in two different places, which read as one setting
 * overriding the other. They are independent:
 *
 * - Fight length is how long each simulated pull lasts (`max_time`).
 * - Search time is how long SimItBoi is allowed to look for better gear.
 *
 * Both live next to the run button now, labelled for what they do, and each
 * has one control rather than a preset in one place and a raw number in
 * another.
 */

export interface Preset {
  seconds: number
  label: string
}

/** Patchwerk only for now; fight style is fixed in the emitted profile. */
export const FIGHT_LENGTHS: readonly Preset[] = [
  { seconds: 60, label: '1 minute' },
  { seconds: 180, label: '3 minutes' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 420, label: '7 minutes' },
  { seconds: 600, label: '10 minutes' }
]

/** Matches the previous default, so restored runs keep their fight length. */
export const DEFAULT_FIGHT_SECONDS = 300

/**
 * How long the Top Gear search may run. Named by effort rather than duration
 * so it cannot be mistaken for the fight length; the time is a target, not a
 * cap, because preparation and final verification always finish.
 */
export const SEARCH_TIMES: readonly Preset[] = [
  { seconds: 60, label: 'Quick · about 1 minute' },
  { seconds: 180, label: 'Standard · about 3 minutes' },
  { seconds: 600, label: 'Thorough · about 10 minutes' }
]

/**
 * A restored run may carry a fight length no preset offers (an older custom
 * value, or a future preset). Keep it selectable rather than silently snapping
 * it to a neighbour, which would change what the run actually measured.
 */
export function fightLengthOptions(current: number): readonly Preset[] {
  if (FIGHT_LENGTHS.some((preset) => preset.seconds === current)) return FIGHT_LENGTHS
  const custom = { seconds: current, label: `${current} seconds · custom` }
  return [...FIGHT_LENGTHS, custom].sort((a, b) => a.seconds - b.seconds)
}
