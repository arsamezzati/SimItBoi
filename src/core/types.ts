/**
 * Core data model for SimItBoi.
 *
 * Design rule: item strings are stored as an ORDERED, VERBATIM
 * token list. Unknown tokens are preserved and re-emitted untouched. Only the
 * tokens Top Gear actually needs are interpreted. M0 confirmed simc
 * handles tokens we don't recognise, so pass-through is correct and sufficient.
 */

/** Normalised equipment slot classes. Excludes cosmetic slots (tabard, shirt). */
export type SlotClass =
  | 'head' | 'neck' | 'shoulder' | 'back' | 'chest' | 'wrist' | 'hands'
  | 'waist' | 'legs' | 'feet' | 'finger' | 'trinket' | 'main_hand' | 'off_hand'

export const SLOT_CLASSES: readonly SlotClass[] = [
  'head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands',
  'waist', 'legs', 'feet', 'finger', 'trinket', 'main_hand', 'off_hand'
]

/** Slots that hold two items at once. */
export const PAIRED_SLOTS: readonly SlotClass[] = ['finger', 'trinket']

/** Cosmetic slots the addon may emit but which never affect a sim. */
export const IGNORED_SLOTS: readonly string[] = ['tabard', 'shirt']

/**
 * Maps an addon-emitted slot name to its normalised class.
 * NOTE: bag items are always emitted as slot 1 (`finger1`, `trinket1`),
 * so the emitted name must NEVER be used for placement.
 */
export function toSlotClass(emitted: string): SlotClass | null {
  const s = emitted.trim().toLowerCase()
  if (IGNORED_SLOTS.includes(s)) return null
  if (s === 'finger1' || s === 'finger2' || s === 'finger') return 'finger'
  if (s === 'trinket1' || s === 'trinket2' || s === 'trinket') return 'trinket'
  return (SLOT_CLASSES as readonly string[]).includes(s) ? (s as SlotClass) : null
}

/**
 * simc's JSON gear keys differ from the addon's slot names:
 * JSON uses plural `shoulders`/`wrists`, the addon uses singular.
 */
export const JSON_GEAR_KEY_TO_SLOT: Readonly<Record<string, SlotClass>> = {
  head: 'head', neck: 'neck', shoulders: 'shoulder', back: 'back', chest: 'chest',
  waist: 'waist', legs: 'legs', feet: 'feet', wrists: 'wrist', hands: 'hands',
  finger1: 'finger', finger2: 'finger', trinket1: 'trinket', trinket2: 'trinket',
  main_hand: 'main_hand', off_hand: 'off_hand'
}

export interface ItemToken {
  key: string
  value: string
}

/** A parsed simc item string. `tokens` is the source of truth for re-emission. */
export interface ItemString {
  /** Slot exactly as the addon wrote it, e.g. "finger1". Never use for placement. */
  emittedSlot: string
  /** Ordered, verbatim. Round-tripping these reproduces the original line. */
  tokens: ItemToken[]
  // --- Derived conveniences. Never authoritative when re-emitting. ---
  id: number
  bonusIds: number[]
  gemIds: number[]
  enchantId?: number
  ilvlOverride?: number
}

export interface CandidateItem {
  item: ItemString
  /** From the preceding `# Name (ilvl)` comment. */
  name: string
  ilvl: number
  slotClass: SlotClass
  /** 'hypothetical' means the user declared it; it is not owned. */
  source: 'equipped' | 'bags' | 'hypothetical'
}

export interface SavedLoadout {
  name: string
  talents: string
}

export interface ProfileHeader {
  characterName?: string
  specLabel?: string
  exportedAt?: string
  region?: string
  realm?: string
  addonVersion?: string
  wowBuild?: string
  tocVersion?: string
  /** From `# Requires SimulationCraft <build> or newer`. Patch-encoded, e.g. "1000-01". */
  requiresSimcBuild?: string
}

export interface Profile {
  raw: string
  checksum?: string
  header: ProfileHeader
  /** The simc class key, taken from the `<class>="Name"` line. */
  className: string
  characterName: string
  level?: number
  race?: string
  role?: string
  spec?: string
  talents?: string
  savedLoadouts: SavedLoadout[]
  /** Profile-level lines we don't interpret (e.g. omnium_talents). Preserved verbatim. */
  extraProfileLines: ItemToken[]
  equipped: CandidateItem[]
  bagItems: CandidateItem[]
  /** `### Additional Character Info` payload: slot_high_watermarks, upgrade_currencies, etc. */
  additionalInfo: Record<string, string>
  /** Non-fatal problems encountered while parsing. */
  warnings: string[]
}
