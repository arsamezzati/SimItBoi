import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CRAFTED_BASE_BONUS_ID, craftedRecipes, findCraftedRecipe, resolveCrafted, searchCraftedRecipes,
  craftedEmbellishmentProblem, legalEmbellishmentsFor, registryExpansion
} from '../src/core/data/crafted.ts'
import { embellishments, embellishedMarker, embellishmentReagentSlots, findEmbellishment } from '../src/core/data/db2.ts'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { parseHypothetical } from '../src/core/topgear/hypothetical.ts'
import { canEquip } from '../src/core/data/itemTable.ts'

const CLASS = 'shaman'
const profile = (): ReturnType<typeof parseAddonProfile> =>
  parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))

/** A crafted legs piece the fixture character can wear. */
const LEGS = 244582

const CLASSES = ['warrior', 'paladin', 'deathknight', 'hunter', 'shaman', 'monk',
  'druid', 'rogue', 'demonhunter', 'evoker', 'priest', 'mage', 'warlock']

/** Some class that can actually equip this recipe, so resolution gets that far. */
function classFor(recipe: { itemId: number; name: string }): string {
  const found = CLASSES.find((className) => canEquip(className, recipe.itemId))
  assert.ok(found, `no class can equip ${recipe.name}`)
  return found
}

const base = { kind: 'crafted' as const, itemId: LEGS, ladderBonusId: 12497, craftingQuality: 5, craftedStats: [40, 32] }

test('the recipe registry agrees with the fixture crafted gear', () => {
  assert.ok(craftedRecipes().length > 50)
  assert.ok(findCraftedRecipe(LEGS), 'the fixture crafted legs have no recipe')
  assert.ok(findCraftedRecipe(245770), 'the fixture crafted weapon has no recipe')
})

test('a crafted item emits the base bonus and its ladder step', () => {
  const r = resolveCrafted(base, CLASS)
  assert.match(r.itemString, new RegExp(`bonus_id=${CRAFTED_BASE_BONUS_ID}/12497`))
  assert.match(r.itemString, /crafted_stats=40\/32/)
  assert.match(r.itemString, /crafting_quality=5/)
  assert.equal(r.ilvl, 331)
})

test('the ladder step decides the level, not a supplied one', () => {
  // A tampered display level must not change what is simulated.
  const r = resolveCrafted({ ...base, ladderBonusId: 12493, ilvl: 999 }, CLASS)
  assert.equal(r.ilvl, 318)
  assert.match(r.itemString, new RegExp(`bonus_id=${CRAFTED_BASE_BONUS_ID}/12493`))
})

test('an embellishment is refused on a slot its recipes never produce', () => {
  const gun = embellishments().find((e) => e.appliesTo === 'guns')!
  // The refusal now names the recipe rather than the slot, because the slot is
  // no longer what decides it.
  assert.throws(
    () => resolveCrafted({ ...base, embellishmentBonusId: gun.bonusId }, CLASS),
    /cannot be applied to Farstrider's Reinforced Faulds/
  )
  const accessory = embellishments().find((e) => e.appliesTo === 'accessories')!
  assert.throws(() => resolveCrafted({ ...base, embellishmentBonusId: accessory.bonusId }, CLASS), /cannot be applied/)
})

test('a legal embellishment carries the marker so the cap can count it', () => {
  const armor = embellishments().find((e) => e.appliesTo === 'armor' && e.expansion === 'Midnight')!
  const r = resolveCrafted({ ...base, embellishmentBonusId: armor.bonusId }, CLASS)
  const bonuses = r.itemString.match(/bonus_id=([\d/]+)/)![1]!.split('/').map(Number)
  assert.ok(bonuses.includes(armor.bonusId), 'effect bonus missing')
  assert.ok(bonuses.includes(embellishedMarker()), 'Embellished marker missing')
  assert.match(r.label, new RegExp(armor.name))
})

test('unsupported crafted configurations are refused', () => {
  assert.throws(() => resolveCrafted({ ...base, itemId: 250214 }, CLASS), /no crafting recipe/)
  assert.throws(() => resolveCrafted({ ...base, ladderBonusId: 99999 }, CLASS), /item level is unavailable/)
  assert.throws(() => resolveCrafted({ ...base, craftingQuality: 9 }, CLASS), /quality must be 1-5/)
  assert.throws(() => resolveCrafted({ ...base, craftedStats: [40] }, CLASS), /exactly two/)
  assert.throws(() => resolveCrafted({ ...base, craftedStats: [40, 40] }, CLASS), /must be different/)
  assert.throws(() => resolveCrafted({ ...base, craftedStats: [40, 999] }, CLASS), /Unknown crafted stat/)
  assert.throws(() => resolveCrafted({ ...base, gemIds: [1, 2, 3] }, CLASS), /socket/)
  assert.throws(() => resolveCrafted({ ...base, enchantId: 999999 }, CLASS), /Unknown enchant/)
})

test('a crafted selection flows through the hypothetical parser', () => {
  const parsed = parseHypothetical(profile(), { itemString: '', selection: base })
  assert.ok(!('reason' in parsed), `rejected: ${(parsed as { reason?: string }).reason}`)
  assert.equal(parsed.candidate.ilvl, 331)
  assert.equal(parsed.candidate.source, 'hypothetical')
})

test('a track selection without a discriminator still resolves as a track item', () => {
  // Stored History payloads predate the discriminator.
  const legacy = { itemId: 250214, track: 'Hero', ilvl: 321 }
  const parsed = parseHypothetical(profile(), { itemString: '', selection: legacy })
  assert.ok(!('reason' in parsed), `legacy track selection was rejected: ${(parsed as { reason?: string }).reason}`)
})

// The search tokenised on the letter s instead of on whitespace, so any query
// containing an s was shredded into fragments that matched nothing. Every
// assertion here fails against that tokenizer.
test('recipe search splits on whitespace, not on the letter s', () => {
  const hunter = 'hunter'
  // Words reversed, and both of them contain an s.
  const reversed = searchCraftedRecipes("reinforced farstrider", "hunter").map((r) => r.name)
  assert.ok(reversed.includes("Farstrider's Reinforced Faulds"),
    `reversed multiword query found ${reversed.length} recipes`)
  // Word order must not matter, so forward order finds the same recipe.
  const forward = searchCraftedRecipes("farstrider reinforced", "hunter").map((r) => r.name)
  assert.deepEqual(forward, reversed)
  // A single word that is mostly s-separated fragments must still match.
  assert.ok(searchCraftedRecipes("scouting vest", "hunter").map((r) => r.name).includes("Farstrider's Scouting Vest"))
  // Extra whitespace between words is not a word.
  assert.deepEqual(searchCraftedRecipes("farstrider   reinforced", "hunter").map((r) => r.name), reversed)
  void hunter
})

test('recipe search still filters by slot and class', () => {
  const legs = searchCraftedRecipes('farstrider reinforced', 'hunter', 'legs')
  assert.ok(legs.every((recipe) => recipe.slot === 'legs'))
  assert.ok(legs.length > 0)
  // A slot the query's recipe does not occupy returns nothing.
  assert.equal(searchCraftedRecipes('farstrider reinforced', 'hunter', 'head').length, 0)
  // An empty query lists what the character can craft rather than throwing.
  assert.ok(searchCraftedRecipes('', 'hunter').length > 0)
})

test('recipe search rejects an over-long query', () => {
  assert.throws(() => searchCraftedRecipes('a'.repeat(121), 'hunter'), /Invalid recipe search/)
})

// Eligibility was an equipment-slot check alone, so an embellishment from
// another expansion and another armor class was accepted because it happened to
// share a slot. Every assertion below passes against that check.

/** The reproduction: Midnight plate chest, Dragon Isles patch. */
const PLATE_CHEST = 237829
const TOXIFIED = 8797

test('a Dragon Isles embellishment is refused on a Midnight recipe', () => {
  assert.equal(registryExpansion(), 'Midnight')
  const recipe = findCraftedRecipe(PLATE_CHEST)
  assert.ok(recipe, 'the reproduction recipe left the registry')
  assert.equal(recipe.subType, 'Plate')
  const toxified = findEmbellishment(TOXIFIED)
  assert.ok(toxified)
  assert.equal(toxified.expansion, 'Dragon Isles')
  assert.equal(toxified.appliesTo, 'leather_mail')

  // Both halves of the restriction are violated, and each must be enough.
  assert.match(craftedEmbellishmentProblem(toxified, recipe) ?? '', /Dragon Isles/)
  const asMidnight = { ...toxified, expansion: 'Midnight' }
  assert.match(craftedEmbellishmentProblem(asMidnight, recipe) ?? '', /cannot be applied to plate/)

  assert.throws(() => resolveCrafted({
    kind: 'crafted', itemId: PLATE_CHEST, ladderBonusId: 12493, craftingQuality: 5,
    craftedStats: [32, 36], embellishmentBonusId: TOXIFIED
  }, 'warrior'), /Dragon Isles/)
})

test('the leather and mail restriction admits leather and mail', () => {
  const toxified = { ...findEmbellishment(TOXIFIED)!, expansion: 'Midnight' }
  const byClass = (subType: string): string | undefined => {
    const recipe = craftedRecipes().find((r) => r.subType === subType && r.canEmbellish && r.embellishmentSlotId === 391)
    assert.ok(recipe, `no embellishable ${subType} recipe`)
    return craftedEmbellishmentProblem(toxified, recipe)
  }
  assert.equal(byClass('Leather'), undefined)
  assert.equal(byClass('Mail'), undefined)
  assert.match(byClass('Plate') ?? '', /cannot be applied to plate/)
  assert.match(byClass('Cloth') ?? '', /cannot be applied to cloth/)
})

test('a profession-restricted embellishment stays on that profession', () => {
  const engineering = embellishments().find((e) => /Engineering Crafted Equipment/i.test(e.categoryNote ?? ''))
  assert.ok(engineering, 'no Engineering embellishment in the table')
  // Its class is 'equipment', which alone would allow every reagent slot.
  assert.equal(engineering.appliesTo, 'equipment')
  assert.deepEqual([...embellishmentReagentSlots(engineering)].sort(), ['499', '501', '502'])

  const engineered = craftedRecipes().find((r) => r.category === 'Engineering Armor' && r.canEmbellish)
  const ordinary = craftedRecipes().find((r) => r.category === 'Plate Armor' && r.canEmbellish)
  assert.ok(engineered && ordinary)
  assert.equal(craftedEmbellishmentProblem(engineering, engineered), undefined)
  assert.match(craftedEmbellishmentProblem(engineering, ordinary) ?? '', /cannot be applied/)
})

test('a profession the registry cannot attribute is refused, not assumed', () => {
  const blacksmithing = embellishments().find((e) => /Blacksmithing/i.test(e.categoryNote ?? ''))
  assert.ok(blacksmithing, 'no Blacksmithing embellishment in the table')
  // No recipe records its profession, so it is unestablished everywhere.
  assert.deepEqual([...embellishmentReagentSlots(blacksmithing)], [])
  for (const recipe of craftedRecipes().filter((r) => r.canEmbellish)) {
    assert.match(craftedEmbellishmentProblem(blacksmithing, recipe) ?? '', /no established recipe eligibility/)
  }
})

test('every embellishable recipe keeps a usable set of embellishments', () => {
  const embellishable = craftedRecipes().filter((r) => r.canEmbellish)
  assert.ok(embellishable.length > 60)
  for (const recipe of embellishable) {
    const legal = legalEmbellishmentsFor(recipe)
    assert.ok(legal.length > 0, `${recipe.name} lost every embellishment`)
    // Nothing from another expansion may survive the filter.
    assert.deepEqual(legal.filter((e) => e.expansion !== registryExpansion()), [])
    // And each one must resolve, not merely list.
    const step = recipe.ilvlLadder[0]!
    assert.doesNotThrow(() => resolveCrafted({
      kind: 'crafted', itemId: recipe.itemId, ladderBonusId: step.bonusId, craftingQuality: 5,
      craftedStats: [40, 32], embellishmentBonusId: legal[0]!.bonusId
    }, classFor(recipe)))
  }
})

test('a recipe that accepts no embellishment still refuses one', () => {
  const plain = craftedRecipes().find((r) => !r.canEmbellish)
  assert.ok(plain)
  assert.deepEqual([...legalEmbellishmentsFor(plain)], [])
  assert.match(craftedEmbellishmentProblem(embellishments()[0]!, plain) ?? '', /does not accept an embellishment/)
})
