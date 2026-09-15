/**
 * Crafted item configuration.
 *
 * The recipe registry is supplied data (`dawncrest-crafts.json`), cross-checked
 * against the recipe walk in db2.json: every item it lists is one the walk found
 * independently, and its embellishment slot ids agree on all 98.
 */
import { createRequire } from 'node:module'
import { canEquip } from './itemTable.ts'
import {
  assertGemCategoryLimits, embellishmentReagentSlots, embellishedMarker, enchantSlot,
  embellishments, findEmbellishment, findEnchant, findGem, socketCount,
  type Embellishment
} from './db2.ts'

const require_ = createRequire(import.meta.url)

/**
 * The Midnight crafted base, carrying item level 318 on its own.
 *
 * MEASURED, not derived: bisecting fixture #1's real bonus list showed three
 * competing `Type=49` bonuses, the highest winning (12214 -> 259, 13751 -> 305,
 * 13836 -> 331 with the Myth ladder bonus). Without it a crafted item resolves
 * at item level 46. Verified across nine slots; `npm run check:gear` re-measures
 * it against the real binary rather than trusting this constant.
 */
export const CRAFTED_BASE_BONUS_ID = 13836

/** Secondary stat ids accepted in `crafted_stats`. */
export const CRAFTED_STATS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 32, name: 'Critical Strike' },
  { id: 36, name: 'Haste' },
  { id: 40, name: 'Versatility' },
  { id: 49, name: 'Mastery' }
]
export const MAX_CRAFTING_QUALITY = 5

export interface LadderStep {
  rank: number
  bonusId: number
  ilvl: number
  offset: number
  label: string
}

export interface CraftedRecipe {
  itemId: number
  name: string
  /** Registry slot name, not a simc emit slot — see `emitSlotFor`. */
  slot: string
  category: string
  subType: string
  /** Item class/subclass, so armor-class restrictions can be checked. */
  itemClassId: number
  itemSubclassId: number
  quality: string
  recipeSpellId: number
  canEmbellish: boolean
  embellishmentSlotId: number | null
  ilvlLadder: LadderStep[]
}

interface CraftedFile {
  version: number
  generated: string
  gameBuild: string
  /** e.g. "11 (Midnight)"; the name is what category notes are written in. */
  expansion: string
  dawncrestReference: { ladder: LadderStep[] }
  items: CraftedRecipe[]
}

let file: CraftedFile | null = null
function data(): CraftedFile {
  file ??= require_('./dawncrest-crafts.json') as CraftedFile
  return file
}

export function craftedRecipes(): readonly CraftedRecipe[] {
  return data().items
}

export function findCraftedRecipe(itemId: number): CraftedRecipe | undefined {
  return data().items.find((i) => i.itemId === itemId)
}

/**
 * Recipes matching every word of `query`, for a character of `className`.
 *
 * Mirrors `searchCatalog`: whitespace-separated words, each of which must
 * appear somewhere in the name or the id, so word order does not matter.
 * This lived inline in the IPC handler and split on the letter s rather than
 * on whitespace, which broke any query containing an s.
 */
export function searchCraftedRecipes(
  query: string,
  className: string,
  slot = ''
): readonly CraftedRecipe[] {
  if (typeof query !== 'string' || query.length > 120 || typeof slot !== 'string') throw new Error('Invalid recipe search')
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return craftedRecipes().filter((recipe) =>
    canEquip(className, recipe.itemId) &&
    (!slot || recipe.slot === slot) &&
    words.every((word) => `${recipe.name.toLowerCase()} ${recipe.itemId}`.includes(word)))
}

/** Registry slot -> the slot a simc item line is emitted under. */
const EMIT_SLOT: Record<string, string> = {
  head: 'head', neck: 'neck', shoulder: 'shoulder', back: 'back', chest: 'chest',
  wrist: 'wrist', hands: 'hands', waist: 'waist', legs: 'legs', feet: 'feet',
  finger: 'finger1', trinket: 'trinket1',
  one_hand: 'main_hand', two_hand: 'main_hand', ranged: 'main_hand',
  off_hand: 'off_hand', shield: 'off_hand', holdable: 'off_hand'
}

export function emitSlotFor(recipe: CraftedRecipe): string | undefined {
  return EMIT_SLOT[recipe.slot]
}


/** Armor subclass ids, for the classes a category note can name. */
const ARMOR_SUBCLASS = { cloth: 1, leather: 2, mail: 3, plate: 4 } as const

/**
 * Armor classes a category is restricted to. Only stated restrictions appear
 * here; a class absent from this map places no armor-class restriction.
 */
const ARMOR_CLASSES_BY_RULE: Record<string, readonly number[]> = {
  leather_mail: [ARMOR_SUBCLASS.leather, ARMOR_SUBCLASS.mail]
}

/** The expansion the shipped recipes belong to, e.g. "11 (Midnight)" -> Midnight. */
export function registryExpansion(): string {
  return data().expansion.replace(/^[0-9]+[^A-Za-z]*/, '').replace(/[()]/g, '').trim()
}

/**
 * Why `embellishment` may not go on `recipe`, or undefined when it may.
 *
 * This used to be a slot check alone, which let a Dragon Isles leather-and-mail
 * embellishment onto a Midnight plate chest: same equipment slot, entirely
 * different recipe. Every restriction the shipped category prose states is
 * checked here, and anything the data cannot establish is refused rather than
 * allowed.
 */
export function craftedEmbellishmentProblem(
  embellishment: Embellishment,
  recipe: CraftedRecipe
): string | undefined {
  if (!recipe.canEmbellish) return 'This recipe does not accept an embellishment'

  // Every category note names its expansion, and a reagent from one expansion
  // is not a reagent for another expansion's recipe.
  const expansion = registryExpansion()
  if (embellishment.expansion !== expansion) {
    return `${embellishment.name} is ${embellishment.expansion} content and cannot be crafted into a ${expansion} recipe`
  }

  // The reagent slot is the mechanism: an embellishment is a reagent placed in
  // this recipe's embellishment slot. Checking the recipe's own slot id is
  // exact, where mapping both sides to an equipment slot is not.
  const allowed = embellishmentReagentSlots(embellishment)
  if (allowed.length === 0) return `${embellishment.name} has no established recipe eligibility`
  if (recipe.embellishmentSlotId === null || !allowed.includes(String(recipe.embellishmentSlotId))) {
    return `${embellishment.name} cannot be applied to ${recipe.name}`
  }

  // Armor-class restrictions survive the slot check: leather, mail and plate
  // chests all share one reagent slot.
  const armorClasses = ARMOR_CLASSES_BY_RULE[embellishment.appliesTo]
  if (armorClasses && !armorClasses.includes(recipe.itemSubclassId)) {
    return `${embellishment.name} cannot be applied to ${recipe.subType.toLowerCase()}`
  }

  return undefined
}

/** Embellishments that may legally go on this recipe. */
export function legalEmbellishmentsFor(recipe: CraftedRecipe): readonly Embellishment[] {
  return embellishments().filter((e) => craftedEmbellishmentProblem(e, recipe) === undefined)
}

/** A crafted configuration, distinct from an upgrade-track selection. */
export interface CraftedSelection {
  kind: 'crafted'
  itemId: number
  /** The ladder bonus id, never a tier name — the naming is unsettled. */
  ladderBonusId: number
  craftingQuality: number
  craftedStats: number[]
  embellishmentBonusId?: number
  gemIds?: number[]
  enchantId?: number
  /**
   * Display only. Resolution derives the level from `ladderBonusId` and never
   * reads this, so a stale or tampered value cannot change what is simulated.
   */
  ilvl?: number
}

/**
 * Resolves a crafted configuration to an exact simc item line, refusing
 * anything whose eligibility is not established. Runs in the main process; the
 * renderer's choices are never trusted.
 */
export function resolveCrafted(
  selection: CraftedSelection,
  className: string
): { itemString: string; label: string; ilvl: number } {
  if (!selection || !Number.isInteger(selection.itemId)) throw new Error('Invalid crafted selection')
  const recipe = findCraftedRecipe(selection.itemId)
  if (!recipe) throw new Error('This item has no crafting recipe')
  const slot = emitSlotFor(recipe)
  if (!slot) throw new Error(`Unsupported crafted slot: ${recipe.slot}`)
  if (!canEquip(className, recipe.itemId)) throw new Error('Item is unavailable for this character')

  const step = recipe.ilvlLadder.find((l) => l.bonusId === selection.ladderBonusId)
  if (!step) throw new Error('This item level is unavailable for this recipe')

  const quality = selection.craftingQuality
  if (!Number.isInteger(quality) || quality < 1 || quality > MAX_CRAFTING_QUALITY) {
    throw new Error(`Crafting quality must be 1-${MAX_CRAFTING_QUALITY}`)
  }

  // Two stats: a single-stat craft leaves an allocation unassigned.
  const stats = selection.craftedStats ?? []
  if (stats.length !== 2) throw new Error('Choose exactly two crafted stats')
  const allowed = new Set(CRAFTED_STATS.map((s) => s.id))
  if (stats.some((id) => !allowed.has(id))) throw new Error('Unknown crafted stat')
  if (new Set(stats).size !== stats.length) throw new Error('Crafted stats must be different')

  const bonuses = [CRAFTED_BASE_BONUS_ID, step.bonusId]
  let embellishLabel = ''
  if (selection.embellishmentBonusId !== undefined) {
    if (!recipe.canEmbellish) throw new Error('This recipe does not accept an embellishment')
    const embellishment = findEmbellishment(selection.embellishmentBonusId)
    if (!embellishment) throw new Error('Unknown embellishment')
    const problem = craftedEmbellishmentProblem(embellishment, recipe)
    if (problem) throw new Error(problem)
    // The marker rides along, or the cap of 2 cannot count it.
    bonuses.push(embellishment.bonusId, embellishedMarker())
    embellishLabel = ` · ${embellishment.name}`
  }

  const extras: string[] = []
  const gemIds = selection.gemIds ?? []
  if (gemIds.length > 0) {
    const sockets = socketCount(recipe.itemId, bonuses)
    if (gemIds.length > sockets) {
      throw new Error(sockets === 0 ? 'This item has no sockets' : `This item has ${sockets} socket${sockets === 1 ? '' : 's'}`)
    }
    if (gemIds.some((id) => !findGem(id))) throw new Error('Unknown gem')
    assertGemCategoryLimits(gemIds)
    extras.push(`gem_id=${gemIds.join('/')}`)
  }

  if (selection.enchantId !== undefined) {
    const found = findEnchant(selection.enchantId)
    if (!found) throw new Error('Unknown enchant')
    if (found.enchant.slot === null) throw new Error('This enchant has unknown slot eligibility')
    if (found.enchant.slot !== enchantSlot(slot)) throw new Error('This enchant cannot be applied to this item slot')
    extras.push(`enchant_id=${selection.enchantId}`)
  }

  // No Type=25 stat bonus is emitted: it would override crafted_stats.
  const parts = [
    `${slot}=,id=${recipe.itemId}`,
    `bonus_id=${[...new Set(bonuses)].join('/')}`,
    `crafted_stats=${stats.join('/')}`,
    `crafting_quality=${quality}`,
    ...extras
  ]
  return {
    itemString: parts.join(','),
    label: `${recipe.name} · crafted ${step.ilvl}${embellishLabel}`,
    ilvl: step.ilvl
  }
}
