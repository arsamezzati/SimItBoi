/**
 * Weapon configuration rules.
 *
 * simc validates armour class but performs NO weapon-rule validation:
 * it will equip a two-hander in an Elemental Shaman's off hand without
 * complaint. Every weapon constraint must therefore be enforced here, or Top
 * Gear will report confident upgrades for gear the game cannot equip.
 *
 * !!! ACCURACY WARNING !!!
 * The spec table below encodes WoW weapon rules as understood at authoring
 * time. The target game build is 12.1.0 (Midnight), which is newer than that
 * understanding, and Blizzard changes weapon eligibility between expansions —
 * Frost DK, Windwalker and the Fury talent pair have all moved historically.
 * Treat SPEC_WEAPON_RULES as data to be verified against the live game, not as
 * settled fact. `verified: false` marks entries nobody has checked against 12.1.
 */
import type { CandidateItem, Profile } from '../types.ts'

/** Inventory type of a weapon-slot item. Comes from the metadata table. */
export type WeaponInventoryType =
  | 'two_hand'
  | 'one_hand'
  /** Off hand only — e.g. items flagged INVTYPE_WEAPONOFFHAND. */
  | 'off_hand_only'
  /** Main hand only. */
  | 'main_hand_only'
  | 'shield'
  /** Caster off-hand / tome / orb. */
  | 'holdable'
  | 'ranged'

/** A legal way to fill the two weapon slots. */
export type WeaponConfig =
  /** One two-hander, off hand empty. */
  | 'two_hand'
  /** One one-hander plus a shield or holdable. */
  | 'one_hand_offhand'
  /** Two one-handers. */
  | 'dual_wield_1h'
  /** Two two-handers. Fury warrior with Titan's Grip. */
  | 'titans_grip'
  /** Ranged weapon in the main-hand slot. */
  | 'ranged'

export interface SpecRules {
  configs: WeaponConfig[]
  /**
   * Configs that exist only under a talent choice. These are enumerated ONLY
   * when the character's currently equipped weapons already match, because the
   * equipped setup encodes the talent decision and Top Gear must not propose a
   * build that requires respeccing.
   */
  talentGated?: WeaponConfig[]
  /**
   * Weapon subclasses this spec actually uses, beyond what the class can
   * wield. A config says whether a two-hander is allowed; this says which kind,
   * so a shadow priest takes a staff and not a two-handed sword.
   *
   * NOT modelled: the stat on the weapon. Balance and Feral druids both use a
   * staff, one wanting intellect and the other agility, and subclass alone
   * cannot separate them.
   */
  mainHand?: number[]
  /** Off-hand item types this spec may use in `one_hand_offhand`. */
  offHand?: Array<'shield' | 'holdable'>
  /** False where the entry has not been checked against WoW 12.1. */
  verified: boolean
}

/**
 * Weapon subclass ids from the bundled item table (item class 2 = Weapon).
 * Shield is item class 4 subclass 6 and is expressed through `offHand`.
 */
export const WEAPON_SUBCLASS = {
  axe1h: 0, axe2h: 1, bow: 2, gun: 3, mace1h: 4, mace2h: 5, polearm: 6,
  sword1h: 7, sword2h: 8, warglaive: 9, staff: 10, fist: 13, dagger: 15,
  crossbow: 18, wand: 19
} as const

const { axe1h, axe2h, bow, gun, mace1h, mace2h, polearm, sword1h, sword2h,
        warglaive, staff, fist, dagger, crossbow, wand } = WEAPON_SUBCLASS

/** Two-handed melee, as every strength spec means it. */
const MELEE_2H = [axe2h, mace2h, sword2h, polearm]
/** One-handed melee for strength specs. */
const MELEE_1H = [axe1h, mace1h, sword1h]

/** Keyed by `<class>:<spec>`, both lowercase, matching the addon string. */
export const SPEC_WEAPON_RULES: Record<string, SpecRules> = {
  // --- Warrior ---
  'warrior:arms': { configs: ['two_hand'], mainHand: MELEE_2H, verified: true },
  'warrior:fury': {
    // Titan's Grip and Single-Minded Fury are both passives, so whichever the
    // character currently wears is the one they are specced for.
    configs: ['titans_grip', 'dual_wield_1h'],
    talentGated: ['titans_grip', 'dual_wield_1h'],
    mainHand: [...MELEE_2H, ...MELEE_1H, fist, dagger, staff],
    verified: true
  },
  'warrior:protection': { configs: ['one_hand_offhand'], offHand: ['shield'], mainHand: MELEE_1H, verified: true },

  // --- Paladin ---
  'paladin:holy': {
    // One-hander plus shield; a two-hander is usable if one drops.
    configs: ['one_hand_offhand', 'two_hand'], offHand: ['shield'],
    mainHand: [...MELEE_1H, ...MELEE_2H], verified: true
  },
  'paladin:protection': { configs: ['one_hand_offhand'], offHand: ['shield'], mainHand: MELEE_1H, verified: true },
  'paladin:retribution': { configs: ['two_hand'], mainHand: MELEE_2H, verified: true },

  // --- Death knight ---
  'deathknight:blood': { configs: ['two_hand'], mainHand: MELEE_2H, verified: true },
  'deathknight:frost': {
    configs: ['two_hand', 'dual_wield_1h'], talentGated: ['two_hand', 'dual_wield_1h'],
    mainHand: [...MELEE_2H, ...MELEE_1H], verified: true
  },
  'deathknight:unholy': { configs: ['two_hand'], mainHand: MELEE_2H, verified: true },

  // --- Demon hunter ---
  'demonhunter:havoc': { configs: ['dual_wield_1h'], mainHand: [warglaive, sword1h, axe1h, fist], verified: true },
  'demonhunter:vengeance': { configs: ['dual_wield_1h'], mainHand: [warglaive, sword1h, axe1h, fist], verified: true },

  // --- Druid ---
  'druid:balance': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, mace1h], verified: true },
  'druid:restoration': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, mace1h], verified: true },
  // Feral and Guardian take a two-handed agility weapon only.
  'druid:feral': { configs: ['two_hand'], mainHand: [staff, polearm, mace2h], verified: true },
  'druid:guardian': { configs: ['two_hand'], mainHand: [staff, polearm, mace2h], verified: true },

  // --- Evoker ---
  'evoker:devastation': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, mace1h, sword1h, axe1h, fist], verified: true },
  'evoker:preservation': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, mace1h, sword1h, axe1h, fist], verified: true },
  'evoker:augmentation': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, mace1h, sword1h, axe1h, fist], verified: true },

  // --- Hunter ---
  'hunter:beast_mastery': { configs: ['ranged'], mainHand: [bow, crossbow, gun], verified: true },
  'hunter:marksmanship': { configs: ['ranged'], mainHand: [bow, crossbow, gun], verified: true },
  'hunter:survival': { configs: ['two_hand'], mainHand: [polearm, staff, sword2h, axe2h], verified: true },

  // --- Mage ---
  'mage:arcane': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, sword1h, wand], verified: true },
  'mage:fire': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, sword1h, wand], verified: true },
  'mage:frost': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, sword1h, wand], verified: true },

  // --- Monk ---
  'monk:brewmaster': { configs: ['two_hand', 'dual_wield_1h'], mainHand: [polearm, staff, fist, axe1h, mace1h, sword1h], verified: true },
  'monk:mistweaver': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, mace1h, sword1h, axe1h, fist], verified: true },
  // Windwalker dual wields one-handers; it does not take a two-hander.
  'monk:windwalker': { configs: ['dual_wield_1h'], mainHand: [fist, sword1h, axe1h, mace1h], verified: true },

  // --- Priest ---
  'priest:discipline': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, mace1h, wand], verified: true },
  'priest:holy': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, mace1h, wand], verified: true },
  'priest:shadow': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, mace1h, wand], verified: true },

  // --- Rogue ---
  // Assassination and Subtlety require daggers; Outlaw takes any one-hander.
  'rogue:assassination': { configs: ['dual_wield_1h'], mainHand: [dagger], verified: true },
  'rogue:subtlety': { configs: ['dual_wield_1h'], mainHand: [dagger], verified: true },
  'rogue:outlaw': { configs: ['dual_wield_1h'], mainHand: [sword1h, axe1h, mace1h, fist, dagger], verified: true },

  // --- Shaman ---
  'shaman:elemental': { configs: ['one_hand_offhand', 'two_hand'], offHand: ['shield'], mainHand: [staff, mace1h, axe1h, dagger, fist], verified: true },
  'shaman:restoration': { configs: ['one_hand_offhand', 'two_hand'], offHand: ['shield'], mainHand: [staff, mace1h, axe1h, dagger, fist], verified: true },
  'shaman:enhancement': { configs: ['dual_wield_1h'], mainHand: [axe1h, mace1h, fist], verified: true },

  // --- Warlock ---
  'warlock:affliction': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, sword1h, wand], verified: true },
  'warlock:demonology': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, sword1h, wand], verified: true },
  'warlock:destruction': { configs: ['two_hand', 'one_hand_offhand'], offHand: ['holdable'], mainHand: [staff, dagger, sword1h, wand], verified: true }
}

export function specKey(profile: Profile): string {
  return `${profile.className}:${(profile.spec ?? '').toLowerCase()}`
}

export function rulesFor(profile: Profile): SpecRules | null {
  return SPEC_WEAPON_RULES[specKey(profile)] ?? null
}

/**
 * Infers the character's current weapon configuration from equipped gear.
 *
 * This is the signal that resolves talent-gated choices without decoding the
 * talent blob: a Fury warrior wearing two two-handers has Titan's Grip, and one
 * wearing two one-handers has Single-Minded Fury. It also caught the phantom-upgrade bug
 * before any metadata table existed.
 *
 * `lookup` supplies inventory types; without it only the empty-off-hand case
 * (necessarily a two-hander) can be determined.
 */
export function inferConfig(
  profile: Profile,
  lookup?: (item: CandidateItem) => WeaponInventoryType | undefined
): WeaponConfig | 'unknown' {
  const mh = profile.equipped.find((c) => c.slotClass === 'main_hand')
  const oh = profile.equipped.find((c) => c.slotClass === 'off_hand')
  if (!mh) return 'unknown'
  if (!oh) {
    if (!lookup) return 'two_hand' // legacy inference when metadata is unavailable
    const type = lookup(mh)
    return type === 'two_hand' || type === 'ranged' ? type : 'unknown'
  }

  if (!lookup) return 'unknown'
  const mhType = lookup(mh)
  const ohType = lookup(oh)
  if (!mhType || !ohType) return 'unknown'

  if (mhType === 'two_hand' && ohType === 'two_hand') return 'titans_grip'
  if (ohType === 'shield' || ohType === 'holdable') return 'one_hand_offhand'
  if ((mhType === 'one_hand' || mhType === 'main_hand_only') && (ohType === 'one_hand' || ohType === 'off_hand_only')) {
    return 'dual_wield_1h'
  }
  return 'unknown'
}

/**
 * The configurations Top Gear may enumerate for this character.
 *
 * Non-talent-gated configs are always allowed. A talent-gated config is allowed
 * only when it matches what the character currently wields, so Top Gear never
 * proposes a set that silently requires a respec.
 */
export function allowedConfigs(
  profile: Profile,
  current: WeaponConfig | 'unknown',
  rules = rulesFor(profile)
): WeaponConfig[] {
  if (!rules) return []
  const gated = new Set(rules.talentGated ?? [])
  return rules.configs.filter((c) => !gated.has(c) || c === current)
}

/**
 * Whether a main-hand/off-hand pair is legal under a given configuration.
 *
 * Checks the config against the spec's own rules first: asking whether an
 * Elemental Shaman may dual-wield must answer no regardless of what the two
 * item types are. Callers should still pass configs from `allowedConfigs()`,
 * but this must not depend on their doing so.
 */
export function isLegalPair(
  config: WeaponConfig,
  mh: WeaponInventoryType | undefined,
  oh: WeaponInventoryType | undefined,
  rules: SpecRules
): boolean {
  if (!rules.configs.includes(config)) return false
  if (!mh) return false
  switch (config) {
    case 'two_hand':
      return mh === 'two_hand' && oh === undefined
    case 'titans_grip':
      return mh === 'two_hand' && oh === 'two_hand'
    case 'ranged':
      return mh === 'ranged' && oh === undefined
    case 'dual_wield_1h':
      return (
        (mh === 'one_hand' || mh === 'main_hand_only') &&
        (oh === 'one_hand' || oh === 'off_hand_only')
      )
    case 'one_hand_offhand': {
      if (mh !== 'one_hand' && mh !== 'main_hand_only') return false
      if (oh !== 'shield' && oh !== 'holdable') return false
      return (rules.offHand ?? []).includes(oh)
    }
  }
}
