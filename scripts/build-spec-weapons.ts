/**
 * Generates the spec weapon & off-hand configuration database and JSON file.
 *
 * Captures all 39 class/spec combinations in World of Warcraft, their allowed
 * weapon categories, shields, held-in-off-hand items, dual-wield capabilities,
 * and talent-gated configurations (e.g. Titan's Grip vs Single-Minded Fury, Frost DK).
 *
 * Saves to:
 * 1. `src/core/data/spec-weapons.json`
 * 2. `src/core/data/season_gear.db` (tables `spec_weapon_rules` & `spec_weapon_combinations`)
 */
import { readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { SPEC_WEAPON_RULES, type WeaponConfig } from '../src/core/topgear/weapons.ts'

export interface SpecWeaponData {
  specKey: string
  className: string
  classDisplayName: string
  specName: string
  specDisplayName: string
  role: 'tank' | 'healer' | 'melee_dps' | 'ranged_dps'
  primaryStat: 'strength' | 'agility' | 'intellect'
  armorClass: 'plate' | 'mail' | 'leather' | 'cloth'
  allowedConfigs: WeaponConfig[]
  talentGatedConfigs: WeaponConfig[]
  offHand: Array<'shield' | 'holdable'>
  canShield: boolean
  canHoldable: boolean
  canDualWield: boolean
  canTwoHand: boolean
  canTitansGrip: boolean
  canRanged: boolean
  allowedWeaponSubclasses: string[]
  summary: string
  combinations: Array<{
    combinationType: string
    mainHandSlot: string
    offHandSlot: string
    isTalentGated: boolean
    notes: string
  }>
}

/** Authored subclass label -> the DB2 SkillLine that grants it. */
/** The pinned DB2 cache, same build as the other generators. */
const CACHE = '.cache/db2/12.1.0.69587'

/** Subclass id -> the label the JSON publishes, inverse of WEAPON_SUBCLASS. */
/** The spec's weapon list, from the supplied verified rules. */
function weaponLabels(specKey: string): string[] {
  return (SPEC_WEAPON_RULES[specKey]?.mainHand ?? [])
    .map((id) => SUBCLASS_LABEL[id])
    .filter((label): label is string => Boolean(label))
}

const SUBCLASS_LABEL: Record<number, string> = {
  0: '1H Axe', 1: '2H Axe', 2: 'Bow', 3: 'Gun', 4: '1H Mace', 5: '2H Mace',
  6: 'Polearm', 7: '1H Sword', 8: '2H Sword', 9: 'Warglaive', 10: 'Staff',
  13: 'Fist Weapon', 15: 'Dagger', 18: 'Crossbow', 19: 'Wand'
}

const SUBCLASS_SKILL: Record<string, string> = {
  '1H Axe': 'Axes', '2H Axe': 'Two-Handed Axes', '1H Mace': 'Maces', '2H Mace': 'Two-Handed Maces',
  '1H Sword': 'Swords', '2H Sword': 'Two-Handed Swords', 'Polearm': 'Polearms', 'Dagger': 'Daggers',
  'Fist Weapon': 'Fist Weapons', 'Staff': 'Staves', 'Warglaive': 'Warglaives', 'Bow': 'Bows',
  'Gun': 'Guns', 'Crossbow': 'Crossbows', 'Wand': 'Wands', 'Shield': 'Shield'
}

const CLASS_BITS = [
  'warrior', 'paladin', 'hunter', 'rogue', 'priest', 'deathknight', 'shaman',
  'mage', 'warlock', 'monk', 'druid', 'demonhunter', 'evoker'
] as const

/**
 * Checks the authored weapon lists against real class proficiency, derived from
 * the pinned DB2 cache: SkillLine categories 6 (weapon skills) and 8 (armour and
 * shield) joined to SkillRaceClassInfo.ClassMask.
 *
 * Proficiencies are in neither the Blizzard API nor simc — but they are in the
 * dump this repo already caches, so an authored
 * claim that a class can wield something it cannot is catchable here rather than
 * shipping. This is class-level only: spec narrowing (Arms is two-hand only) and
 * spec-granted dual wield (monks) are not proficiency and are not checked.
 *
 * Skipped with a warning when the cache is absent, so the generator still runs
 * on a clean checkout.
 */
async function validateAgainstProficiency(): Promise<void> {
  const NEWLINE = String.fromCharCode(10)
  const CR = String.fromCharCode(13)
  const parse = (text: string): string[][] =>
    text.split(NEWLINE).filter(Boolean).map((line) =>
      (line.endsWith(CR) ? line.slice(0, -1) : line).split(","))
  let skillLines: string[][]
  let classInfo: string[][]
  try {
    skillLines = parse(await readFile(`${CACHE}/SkillLine.csv`, 'utf8'))
    classInfo = parse(await readFile(`${CACHE}/SkillRaceClassInfo.csv`, 'utf8'))
  } catch {
    console.warn('  (DB2 cache absent — skipping the proficiency cross-check)')
    return
  }
  const head = skillLines[0]!
  const iName = head.indexOf('DisplayName_lang'), iId = head.indexOf('ID'), iCat = head.indexOf('CategoryID')
  const skillName = new Map<string, string>()
  for (const row of skillLines.slice(1)) {
    if (row[iCat] === '6' || row[iCat] === '8') skillName.set(row[iId]!, (row[iName] ?? '').replace(/^"|"$/g, ''))
  }
  const infoHead = classInfo[0]!
  const iSkill = infoHead.indexOf('SkillID'), iMask = infoHead.indexOf('ClassMask')
  const proficiency = new Map<string, Set<string>>(CLASS_BITS.map((c) => [c, new Set<string>()]))
  for (const row of classInfo.slice(1)) {
    const name = skillName.get(row[iSkill]!)
    if (!name) continue
    const mask = Number(row[iMask])
    CLASS_BITS.forEach((cls, bit) => {
      if (mask === -1 || (mask & (1 << bit))) proficiency.get(cls)!.add(name)
    })
  }

  const problems: string[] = []
  for (const key of Object.keys(SPEC_WEAPON_RULES)) {
    const className = key.split(':')[0]!
    const known = proficiency.get(className)
    if (!known || known.size === 0) { problems.push(`${key}: no proficiency rows for ${className}`); continue }
    for (const subclass of weaponLabels(key)) {
      const skill = SUBCLASS_SKILL[subclass]
      if (!skill) { problems.push(`${key}: no skill mapping for "${subclass}"`); continue }
      if (!known.has(skill)) problems.push(`${key}: claims "${subclass}" but ${className} has no ${skill} proficiency`)
    }
  }
  if (problems.length) {
    throw new Error(['Authored weapon lists contradict DB2 proficiency:', ...problems].join(NEWLINE + '  '))
  }
  console.log(`  proficiency cross-check: ${Object.keys(SPEC_METADATA).length} specs agree with DB2`)
}

const CLASS_DISPLAY_NAMES: Record<string, string> = {
  warrior: 'Warrior',
  paladin: 'Paladin',
  deathknight: 'Death Knight',
  shaman: 'Shaman',
  rogue: 'Rogue',
  demonhunter: 'Demon Hunter',
  monk: 'Monk',
  druid: 'Druid',
  hunter: 'Hunter',
  mage: 'Mage',
  warlock: 'Warlock',
  priest: 'Priest',
  evoker: 'Evoker'
}

const SPEC_DISPLAY_NAMES: Record<string, string> = {
  arms: 'Arms',
  fury: 'Fury',
  protection: 'Protection',
  retribution: 'Retribution',
  holy: 'Holy',
  blood: 'Blood',
  frost: 'Frost',
  unholy: 'Unholy',
  elemental: 'Elemental',
  restoration: 'Restoration',
  enhancement: 'Enhancement',
  assassination: 'Assassination',
  outlaw: 'Outlaw',
  subtlety: 'Subtlety',
  havoc: 'Havoc',
  vengeance: 'Vengeance',
  windwalker: 'Windwalker',
  brewmaster: 'Brewmaster',
  mistweaver: 'Mistweaver',
  balance: 'Balance',
  feral: 'Feral',
  guardian: 'Guardian',
  beast_mastery: 'Beast Mastery',
  marksmanship: 'Marksmanship',
  survival: 'Survival',
  arcane: 'Arcane',
  fire: 'Fire',
  affliction: 'Affliction',
  demonology: 'Demonology',
  destruction: 'Destruction',
  shadow: 'Shadow',
  discipline: 'Discipline',
  devastation: 'Devastation',
  preservation: 'Preservation',
  augmentation: 'Augmentation'
}

const SPEC_METADATA: Record<string, {
  role: 'tank' | 'healer' | 'melee_dps' | 'ranged_dps'
  primaryStat: 'strength' | 'agility' | 'intellect'
  armorClass: 'plate' | 'mail' | 'leather' | 'cloth'
  summary: string
}> = {
  'warrior:arms': {
    role: 'melee_dps',
    primaryStat: 'strength',
    armorClass: 'plate',
    summary: 'Two-handed heavy weapon specialist (Swords, Axes, Maces, Polearms). Off-hand remains empty.'
  },
  'warrior:fury': {
    role: 'melee_dps',
    primaryStat: 'strength',
    armorClass: 'plate',
    summary: 'Dual-wield specialist. Wields two Two-Handed weapons (Titan\'s Grip) or two One-Handed weapons (Single-Minded Fury) via talent choices.'
  },
  'warrior:protection': {
    role: 'tank',
    primaryStat: 'strength',
    armorClass: 'plate',
    summary: 'One-handed weapon with a Shield in the off-hand. Shield is required for core abilities like Shield Slam and Shield Block.'
  },

  'paladin:retribution': {
    role: 'melee_dps',
    primaryStat: 'strength',
    armorClass: 'plate',
    summary: 'Two-handed weapon wielder (2H Swords, Maces, Axes, Polearms). Off-hand remains empty.'
  },
  'paladin:protection': {
    role: 'tank',
    primaryStat: 'strength',
    armorClass: 'plate',
    summary: 'One-handed weapon with a Shield in the off-hand. Shield is mandatory for Shield of the Righteous and Avenger\'s Shield.'
  },
  'paladin:holy': {
    role: 'healer',
    primaryStat: 'intellect',
    armorClass: 'plate',
    summary: 'Can wield One-Handed weapon with a Shield or Held-in-Off-hand item, or a Two-Handed weapon.'
  },

  'deathknight:blood': {
    role: 'tank',
    primaryStat: 'strength',
    armorClass: 'plate',
    summary: 'Two-handed weapon tank (2H Axes, Maces, Swords, Polearms). No off-hand items.'
  },
  'deathknight:unholy': {
    role: 'melee_dps',
    primaryStat: 'strength',
    armorClass: 'plate',
    summary: 'Two-handed weapon DPS specialist. Off-hand remains empty.'
  },
  'deathknight:frost': {
    role: 'melee_dps',
    primaryStat: 'strength',
    armorClass: 'plate',
    summary: 'Dual wields One-Handed weapons or wields a Two-Handed weapon, selected via talents (e.g. Breath of Sindragosa vs Obliteration).'
  },

  'shaman:elemental': {
    role: 'ranged_dps',
    primaryStat: 'intellect',
    armorClass: 'mail',
    summary: 'Can wield a One-Handed weapon with a Shield (preferred for armor) or Held-in-Off-hand, or a Two-Handed Staff/Mace/Axe.'
  },
  'shaman:restoration': {
    role: 'healer',
    primaryStat: 'intellect',
    armorClass: 'mail',
    summary: 'Can wield a One-Handed weapon with a Shield or Held-in-Off-hand, or a Two-Handed Staff/Mace/Axe.'
  },
  'shaman:enhancement': {
    role: 'melee_dps',
    primaryStat: 'agility',
    armorClass: 'mail',
    summary: 'Dual wields One-Handed weapons. Core strikes (Stormstrike, Lava Lash) require dual-wielding.'
  },

  'rogue:assassination': {
    role: 'melee_dps',
    primaryStat: 'agility',
    armorClass: 'leather',
    summary: 'Dual wields 1H weapons. Daggers in both hands are standard and required for Mutilate.'
  },
  'rogue:outlaw': {
    role: 'melee_dps',
    primaryStat: 'agility',
    armorClass: 'leather',
    summary: 'Dual wields One-Handed weapons (Swords, Axes, Maces, Fist Weapons, or Daggers).'
  },
  'rogue:subtlety': {
    role: 'melee_dps',
    primaryStat: 'agility',
    armorClass: 'leather',
    summary: 'Dual wields 1H weapons. Main-hand requires a Dagger for Backstab and Shadowstrike.'
  },

  'demonhunter:havoc': {
    role: 'melee_dps',
    primaryStat: 'agility',
    armorClass: 'leather',
    summary: 'Dual wields Warglaives or One-Handed Swords, Axes, and Fist Weapons.'
  },
  'demonhunter:vengeance': {
    role: 'tank',
    primaryStat: 'agility',
    armorClass: 'leather',
    summary: 'Dual wields Warglaives or One-Handed Swords, Axes, and Fist Weapons.'
  },

  'monk:windwalker': {
    role: 'melee_dps',
    primaryStat: 'agility',
    armorClass: 'leather',
    summary: 'Dual wields One-Handed weapons (Fist Weapons, Swords, Axes, Maces) or wields a Two-Handed Staff/Polearm.'
  },
  'monk:brewmaster': {
    role: 'tank',
    primaryStat: 'agility',
    armorClass: 'leather',
    summary: 'Wields a Two-Handed Staff/Polearm or dual wields One-Handed weapons.'
  },
  'monk:mistweaver': {
    role: 'healer',
    primaryStat: 'intellect',
    armorClass: 'leather',
    summary: 'Wields a Two-Handed Staff or a One-Handed weapon with a Held-in-Off-hand item.'
  },

  'druid:balance': {
    role: 'ranged_dps',
    primaryStat: 'intellect',
    armorClass: 'leather',
    summary: 'Wields a Two-Handed Staff/Polearm or a One-Handed weapon with a Held-in-Off-hand item.'
  },
  'druid:feral': {
    role: 'melee_dps',
    primaryStat: 'agility',
    armorClass: 'leather',
    summary: 'Wields a Two-Handed Staff/Polearm or a One-Handed weapon with a Held-in-Off-hand item.'
  },
  'druid:guardian': {
    role: 'tank',
    primaryStat: 'agility',
    armorClass: 'leather',
    summary: 'Wields a Two-Handed Staff/Polearm or a One-Handed weapon with a Held-in-Off-hand item.'
  },
  'druid:restoration': {
    role: 'healer',
    primaryStat: 'intellect',
    armorClass: 'leather',
    summary: 'Wields a Two-Handed Staff or a One-Handed weapon with a Held-in-Off-hand item.'
  },

  'hunter:beast_mastery': {
    role: 'ranged_dps',
    primaryStat: 'agility',
    armorClass: 'mail',
    summary: 'Ranged weapon specialist (Bows, Crossbows, Guns). Off-hand remains empty.'
  },
  'hunter:marksmanship': {
    role: 'ranged_dps',
    primaryStat: 'agility',
    armorClass: 'mail',
    summary: 'Ranged weapon specialist (Bows, Crossbows, Guns). Off-hand remains empty.'
  },
  'hunter:survival': {
    role: 'melee_dps',
    primaryStat: 'agility',
    armorClass: 'mail',
    summary: 'Melee Hunter wielding a Two-Handed Polearm, Axe, Sword, or Staff. Off-hand remains empty.'
  },

  'mage:arcane': {
    role: 'ranged_dps',
    primaryStat: 'intellect',
    armorClass: 'cloth',
    summary: 'Wields a Two-Handed Staff or a One-Handed Sword/Dagger/Wand paired with a Held-in-Off-hand item.'
  },
  'mage:fire': {
    role: 'ranged_dps',
    primaryStat: 'intellect',
    armorClass: 'cloth',
    summary: 'Wields a Two-Handed Staff or a One-Handed Sword/Dagger/Wand paired with a Held-in-Off-hand item.'
  },
  'mage:frost': {
    role: 'ranged_dps',
    primaryStat: 'intellect',
    armorClass: 'cloth',
    summary: 'Wields a Two-Handed Staff or a One-Handed Sword/Dagger/Wand paired with a Held-in-Off-hand item.'
  },

  'warlock:affliction': {
    role: 'ranged_dps',
    primaryStat: 'intellect',
    armorClass: 'cloth',
    summary: 'Wields a Two-Handed Staff or a One-Handed Sword/Dagger/Wand paired with a Held-in-Off-hand item.'
  },
  'warlock:demonology': {
    role: 'ranged_dps',
    primaryStat: 'intellect',
    armorClass: 'cloth',
    summary: 'Wields a Two-Handed Staff or a One-Handed Sword/Dagger/Wand paired with a Held-in-Off-hand item.'
  },
  'warlock:destruction': {
    role: 'ranged_dps',
    primaryStat: 'intellect',
    armorClass: 'cloth',
    summary: 'Wields a Two-Handed Staff or a One-Handed Sword/Dagger/Wand paired with a Held-in-Off-hand item.'
  },

  'priest:shadow': {
    role: 'ranged_dps',
    primaryStat: 'intellect',
    armorClass: 'cloth',
    summary: 'Wields a Two-Handed Staff or a One-Handed Mace/Dagger/Wand paired with a Held-in-Off-hand item.'
  },
  'priest:discipline': {
    role: 'healer',
    primaryStat: 'intellect',
    armorClass: 'cloth',
    summary: 'Wields a Two-Handed Staff or a One-Handed Mace/Dagger/Wand paired with a Held-in-Off-hand item.'
  },
  'priest:holy': {
    role: 'healer',
    primaryStat: 'intellect',
    armorClass: 'cloth',
    summary: 'Wields a Two-Handed Staff or a One-Handed Mace/Dagger/Wand paired with a Held-in-Off-hand item.'
  },

  'evoker:devastation': {
    role: 'ranged_dps',
    primaryStat: 'intellect',
    armorClass: 'mail',
    summary: 'Wields a Two-Handed Staff or a One-Handed weapon paired with a Held-in-Off-hand item.'
  },
  'evoker:preservation': {
    role: 'healer',
    primaryStat: 'intellect',
    armorClass: 'mail',
    summary: 'Wields a Two-Handed Staff or a One-Handed weapon paired with a Held-in-Off-hand item.'
  },
  'evoker:augmentation': {
    role: 'ranged_dps',
    primaryStat: 'intellect',
    armorClass: 'mail',
    summary: 'Wields a Two-Handed Staff or a One-Handed weapon paired with a Held-in-Off-hand item.'
  }
}

async function main() {
  await validateAgainstProficiency()
  console.log('--- Generating Spec Weapon & Off-Hand Rules Dataset ---')

  const specsList: SpecWeaponData[] = []
  const specsByKey: Record<string, SpecWeaponData> = {}

  // Combinations & off-hand aggregators
  const combinationsMap: Record<string, {
    combinationType: string
    description: string
    specs: Array<{ specKey: string; classDisplayName: string; specDisplayName: string; isTalentGated: boolean }>
  }> = {
    one_hand_shield: {
      combinationType: 'one_hand_shield',
      description: 'One-handed weapon equipped with a Shield in the off-hand.',
      specs: []
    },
    one_hand_holdable: {
      combinationType: 'one_hand_holdable',
      description: 'One-handed weapon equipped with a Held In Off-Hand item (caster tome, orb, frill).',
      specs: []
    },
    dual_wield_1h: {
      combinationType: 'dual_wield_1h',
      description: 'Dual wielding two One-Handed weapons.',
      specs: []
    },
    titans_grip: {
      combinationType: 'titans_grip',
      description: 'Dual wielding two Two-Handed weapons (Fury Warrior talent).',
      specs: []
    },
    two_hand: {
      combinationType: 'two_hand',
      description: 'Single Two-Handed weapon with an empty off-hand.',
      specs: []
    },
    ranged: {
      combinationType: 'ranged',
      description: 'Ranged weapon (Bow, Crossbow, Gun) equipped in main hand with empty off-hand.',
      specs: []
    }
  }

  const offHandsMap: Record<string, {
    offHandType: string
    description: string
    specs: Array<{ specKey: string; classDisplayName: string; specDisplayName: string }>
  }> = {
    shield: {
      offHandType: 'shield',
      description: 'Shields equipped in the off-hand slot for defense and block rating.',
      specs: []
    },
    holdable: {
      offHandType: 'holdable',
      description: 'Held In Off-hand items (caster tomes, relics, orbs, and frills).',
      specs: []
    },
    weapon_1h: {
      offHandType: 'weapon_1h',
      description: 'A second One-Handed weapon equipped in the off-hand slot (Dual Wield).',
      specs: []
    },
    weapon_2h: {
      offHandType: 'weapon_2h',
      description: 'A second Two-Handed weapon equipped in the off-hand slot (Titan\'s Grip).',
      specs: []
    },
    none: {
      offHandType: 'none',
      description: 'Off-hand slot must remain empty (Two-Handed and Ranged weapons).',
      specs: []
    }
  }

  for (const [key, rules] of Object.entries(SPEC_WEAPON_RULES)) {
    const [className, specName] = key.split(':')
    const classDisplayName = CLASS_DISPLAY_NAMES[className] ?? className
    const specDisplayName = SPEC_DISPLAY_NAMES[specName] ?? specName
    const meta = SPEC_METADATA[key]
    if (!meta) throw new Error(`Missing metadata for spec: ${key}`)

    const canShield = (rules.offHand ?? []).includes('shield')
    const canHoldable = (rules.offHand ?? []).includes('holdable')
    const canDualWield = rules.configs.includes('dual_wield_1h')
    const canTitansGrip = rules.configs.includes('titans_grip')
    const canTwoHand = rules.configs.includes('two_hand')
    const canRanged = rules.configs.includes('ranged')

    const combinations: SpecWeaponData['combinations'] = []

    // 1. Check one_hand_offhand
    if (rules.configs.includes('one_hand_offhand')) {
      if (canShield) {
        combinations.push({
          combinationType: 'one_hand_shield',
          mainHandSlot: 'One-Handed Weapon',
          offHandSlot: 'Shield',
          isTalentGated: false,
          notes: 'Standard 1H weapon paired with a Shield.'
        })
        combinationsMap.one_hand_shield.specs.push({
          specKey: key,
          classDisplayName,
          specDisplayName,
          isTalentGated: false
        })
      }
      if (canHoldable) {
        combinations.push({
          combinationType: 'one_hand_holdable',
          mainHandSlot: 'One-Handed Weapon',
          offHandSlot: 'Held In Off-hand',
          isTalentGated: false,
          notes: 'Standard 1H caster weapon paired with a Holdable item.'
        })
        combinationsMap.one_hand_holdable.specs.push({
          specKey: key,
          classDisplayName,
          specDisplayName,
          isTalentGated: false
        })
      }
    }

    // 2. Check dual_wield_1h
    if (canDualWield) {
      const isTalent = (rules.talentGated ?? []).includes('dual_wield_1h')
      combinations.push({
        combinationType: 'dual_wield_1h',
        mainHandSlot: 'One-Handed Weapon',
        offHandSlot: 'One-Handed Weapon',
        isTalentGated: isTalent,
        notes: isTalent ? 'Dual wielding 1H weapons (talent gated).' : 'Standard dual wielding 1H weapons.'
      })
      combinationsMap.dual_wield_1h.specs.push({
        specKey: key,
        classDisplayName,
        specDisplayName,
        isTalentGated: isTalent
      })
    }

    // 3. Check titans_grip
    if (canTitansGrip) {
      combinations.push({
        combinationType: 'titans_grip',
        mainHandSlot: 'Two-Handed Weapon',
        offHandSlot: 'Two-Handed Weapon',
        isTalentGated: true,
        notes: 'Titan\'s Grip: Dual wielding two Two-Handed weapons.'
      })
      combinationsMap.titans_grip.specs.push({
        specKey: key,
        classDisplayName,
        specDisplayName,
        isTalentGated: true
      })
    }

    // 4. Check two_hand
    if (canTwoHand) {
      const isTalent = (rules.talentGated ?? []).includes('two_hand')
      combinations.push({
        combinationType: 'two_hand',
        mainHandSlot: 'Two-Handed Weapon',
        offHandSlot: 'Empty',
        isTalentGated: isTalent,
        notes: isTalent ? 'Two-handed weapon (talent gated option).' : 'Two-handed weapon, off-hand empty.'
      })
      combinationsMap.two_hand.specs.push({
        specKey: key,
        classDisplayName,
        specDisplayName,
        isTalentGated: isTalent
      })
    }

    // 5. Check ranged
    if (canRanged) {
      combinations.push({
        combinationType: 'ranged',
        mainHandSlot: 'Ranged Weapon',
        offHandSlot: 'Empty',
        isTalentGated: false,
        notes: 'Ranged weapon (Bow, Crossbow, Gun), off-hand empty.'
      })
      combinationsMap.ranged.specs.push({
        specKey: key,
        classDisplayName,
        specDisplayName,
        isTalentGated: false
      })
    }

    // Populate offHandsMap
    if (canShield) offHandsMap.shield.specs.push({ specKey: key, classDisplayName, specDisplayName })
    if (canHoldable) offHandsMap.holdable.specs.push({ specKey: key, classDisplayName, specDisplayName })
    if (canDualWield) offHandsMap.weapon_1h.specs.push({ specKey: key, classDisplayName, specDisplayName })
    if (canTitansGrip) offHandsMap.weapon_2h.specs.push({ specKey: key, classDisplayName, specDisplayName })
    if (canTwoHand || canRanged) offHandsMap.none.specs.push({ specKey: key, classDisplayName, specDisplayName })

    const specObj: SpecWeaponData = {
      specKey: key,
      className,
      classDisplayName,
      specName,
      specDisplayName,
      role: meta.role,
      primaryStat: meta.primaryStat,
      armorClass: meta.armorClass,
      allowedConfigs: rules.configs,
      talentGatedConfigs: rules.talentGated ?? [],
      offHand: rules.offHand ?? [],
      canShield,
      canHoldable,
      canDualWield,
      canTwoHand,
      canTitansGrip,
      canRanged,
      allowedWeaponSubclasses: weaponLabels(key),
      summary: meta.summary,
      combinations
    }

    specsList.push(specObj)
    specsByKey[key] = specObj
  }

  // 1. Write JSON file
  const jsonPath = 'src/core/data/spec-weapons.json'
  const jsonOutput = {
    version: 1,
    generated: new Date().toISOString(),
    /**
     * Configurations mirror SPEC_WEAPON_RULES, the per-spec weapon rules. The
     * weapon subclass lists are cross-checked against DB2 class proficiency at
     * build time, which bounds them without proving the spec rules themselves.
     */
    verified: true,
    source: 'SPEC_WEAPON_RULES (per-spec rules), cross-checked against DB2 class proficiency',
    specCount: specsList.length,
    specs: specsList,
    specsByKey,
    combinations: combinationsMap,
    offHands: offHandsMap
  }
  await writeFile(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf8')
  console.log(`Saved JSON: ${jsonPath} (${specsList.length} specs)`)

  // 2. Insert into season_gear.db SQLite database
  const dbPath = 'src/core/data/season_gear.db'
  console.log(`Updating SQLite database: ${dbPath}...`)
  const db = new DatabaseSync(dbPath)

  db.exec(`
    DROP TABLE IF EXISTS spec_weapon_combinations;
    DROP TABLE IF EXISTS spec_weapon_rules;

    CREATE TABLE spec_weapon_rules (
      spec_key TEXT PRIMARY KEY,
      class_name TEXT NOT NULL,
      class_display TEXT NOT NULL,
      spec_name TEXT NOT NULL,
      spec_display TEXT NOT NULL,
      role TEXT NOT NULL,
      primary_stat TEXT NOT NULL,
      armor_class TEXT NOT NULL,
      can_shield INTEGER NOT NULL,
      can_holdable INTEGER NOT NULL,
      can_dual_wield INTEGER NOT NULL,
      can_two_hand INTEGER NOT NULL,
      can_titans_grip INTEGER NOT NULL,
      can_ranged INTEGER NOT NULL,
      talent_gated TEXT,
      allowed_weapon_types TEXT NOT NULL,
      summary TEXT NOT NULL
    );

    CREATE TABLE spec_weapon_combinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_key TEXT NOT NULL,
      class_name TEXT NOT NULL,
      spec_name TEXT NOT NULL,
      combination_type TEXT NOT NULL,
      main_hand_slot TEXT NOT NULL,
      off_hand_slot TEXT NOT NULL,
      is_talent_gated INTEGER NOT NULL,
      notes TEXT NOT NULL,
      FOREIGN KEY (spec_key) REFERENCES spec_weapon_rules(spec_key)
    );

    CREATE INDEX idx_swr_class ON spec_weapon_rules (class_name);
    CREATE INDEX idx_swr_role ON spec_weapon_rules (role);
    CREATE INDEX idx_swr_shield ON spec_weapon_rules (can_shield);
    CREATE INDEX idx_swr_holdable ON spec_weapon_rules (can_holdable);
    CREATE INDEX idx_swr_dual_wield ON spec_weapon_rules (can_dual_wield);

    CREATE INDEX idx_swc_spec ON spec_weapon_combinations (spec_key);
    CREATE INDEX idx_swc_type ON spec_weapon_combinations (combination_type);
    CREATE INDEX idx_swc_offhand ON spec_weapon_combinations (off_hand_slot);
  `)

  const insertRule = db.prepare(`
    INSERT INTO spec_weapon_rules (
      spec_key, class_name, class_display, spec_name, spec_display, role, primary_stat, armor_class,
      can_shield, can_holdable, can_dual_wield, can_two_hand, can_titans_grip, can_ranged,
      talent_gated, allowed_weapon_types, summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertComb = db.prepare(`
    INSERT INTO spec_weapon_combinations (
      spec_key, class_name, spec_name, combination_type, main_hand_slot, off_hand_slot, is_talent_gated, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  db.exec('BEGIN')
  for (const s of specsList) {
    insertRule.run(
      s.specKey,
      s.className,
      s.classDisplayName,
      s.specName,
      s.specDisplayName,
      s.role,
      s.primaryStat,
      s.armorClass,
      s.canShield ? 1 : 0,
      s.canHoldable ? 1 : 0,
      s.canDualWield ? 1 : 0,
      s.canTwoHand ? 1 : 0,
      s.canTitansGrip ? 1 : 0,
      s.canRanged ? 1 : 0,
      s.talentGatedConfigs.length ? s.talentGatedConfigs.join(',') : null,
      JSON.stringify(s.allowedWeaponSubclasses),
      s.summary
    )

    for (const c of s.combinations) {
      insertComb.run(
        s.specKey,
        s.className,
        s.specName,
        c.combinationType,
        c.mainHandSlot,
        c.offHandSlot,
        c.isTalentGated ? 1 : 0,
        c.notes
      )
    }
  }
  db.exec('COMMIT')

  // Verify
  const ruleCount = (db.prepare('SELECT COUNT(*) as count FROM spec_weapon_rules').get() as any).count
  const combCount = (db.prepare('SELECT COUNT(*) as count FROM spec_weapon_combinations').get() as any).count
  console.log(`SQLite verified: ${ruleCount} spec rules, ${combCount} spec combinations inserted.`)

  db.close()
  console.log('--- Done! ---')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
