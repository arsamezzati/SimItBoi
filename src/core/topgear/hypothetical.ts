/**
 * Hypothetical gear candidates.
 *
 * Lets a player evaluate gear they do not own — an item they are considering
 * crafting, a drop they might win, an upgrade track they have not bought.
 *
 * Two rules this module exists to enforce:
 *
 *  1. A hypothetical item is *declared*, never inferred. It is built from an
 *     exact simc item string the user supplies, validated against the same
 *     metadata every owned item passes, and marked so the solver can tell the
 *     difference between "the user asked for this" and unvetted input.
 *
 *  2. Embellishment is declared, not guessed. The owned-gear rule counts crafted epics as
 *     embellished because nothing identifies an embellished item; that proxy is
 *     harmless on owned gear but wrong exactly here, where a player weighs three
 *     craftable epics of which one may be plain. The user is constructing the
 *     item, so they say.
 */
import type { CandidateItem, ItemString, Profile, SlotClass } from '../types.ts'
import { toSlotClass } from '../types.ts'
import { canEquip, lookupItem } from '../data/itemTable.ts'
import { catalogItem, catalogSlot, resolveCatalog, type CatalogSelection } from '../data/catalog.ts'
import { assertGemCategoryLimits } from '../data/db2.ts'
import { resolveCrafted, type CraftedSelection } from '../data/crafted.ts'

/**
 * How an item was configured. Track selections predate the discriminator, so a
 * selection without `kind` is a track selection — stored History payloads keep
 * deserializing unchanged.
 */
export type ItemSelection = CatalogSelection | CraftedSelection

function isCrafted(selection: ItemSelection): selection is CraftedSelection {
  return selection.kind === 'crafted'
}

/** What the user supplies for one hypothetical candidate. */
export interface HypotheticalInput {
  selection?: ItemSelection
  /** A simc item line, e.g. `trinket1=,id=250214,bonus_id=6652/12846`. */
  itemString: string
  /** Optional display name; the item's real name is used when omitted. */
  label?: string
  /**
   * Whether this item carries an embellishment. Declared, because nothing can
   * detect it. Counts toward the cap of 2.
   */
  embellished?: boolean
}

export interface HypotheticalCandidate {
  candidate: CandidateItem
  /** Undefined means the advanced import's eligibility is unknown. */
  embellished?: boolean
}

export interface HypotheticalError {
  itemString: string
  reason: string
}

const RE_ITEM_LINE = /^\s*(?:#\s*)?([a-z_][a-z0-9_]*)\s*=\s*,(.*)$/i

function parseTokens(body: string): Array<{ key: string; value: string }> {
  const tokens: Array<{ key: string; value: string }> = []
  for (const part of body.split(',')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    if (eq === -1) tokens.push({ key: part, value: '' })
    else tokens.push({ key: part.slice(0, eq), value: part.slice(eq + 1) })
  }
  return tokens
}

function numList(v: string | undefined): number[] {
  if (!v) return []
  return v.split('/').map(Number).filter(Number.isFinite)
}

/**
 * Parses one user-supplied item line into a candidate, or explains why not.
 *
 * Validation is deliberately the same as for owned gear: an item the user typed
 * is still checked against armour class and slot metadata, because a
 * hypothetical set that the character could never wear is worth no more than a
 * phantom upgrade.
 */
export function parseHypothetical(
  profile: Profile,
  input: HypotheticalInput
): HypotheticalCandidate | HypotheticalError {
  let resolved: ReturnType<typeof resolveCatalog> | undefined
  if (input.selection) {
    const selection = input.selection
    try {
      resolved = isCrafted(selection)
        ? resolveCrafted(selection, profile.className)
        : resolveCatalog(selection, profile.className)
    } catch (error) { return { itemString: input.itemString ?? '', reason: (error as Error).message } }
  }
  const raw = (resolved?.itemString ?? input.itemString ?? '').trim()
  const fail = (reason: string): HypotheticalError => ({ itemString: raw, reason })
  if (raw === '') return fail('Empty item string')

  const m = raw.match(RE_ITEM_LINE)
  if (!m) return fail('Not a simc item line — expected something like `trinket1=,id=250214,bonus_id=...`')

  const emittedSlot = m[1].toLowerCase()
  const slotClass = toSlotClass(emittedSlot)
  if (slotClass === null) return fail(`Slot "${emittedSlot}" is not a simulated equipment slot`)

  const tokens = parseTokens(m[2])
  const get = (k: string): string | undefined => tokens.find((t) => t.key === k)?.value
  const id = Number(get('id'))
  if (!Number.isFinite(id) || id <= 0) return fail('Item string has no valid id')

  const meta = lookupItem(id)
  if (!meta) {
    return fail(`Item ${id} is not in the bundled item table. Weapon and unique rules cannot be checked for it.`)
  }
  if (!canEquip(profile.className, id)) {
    return fail(`A ${profile.className} cannot wear this item (${meta.armorClass ?? meta.inventoryType})`)
  }
  if (meta.weaponType && slotClass !== 'main_hand' && slotClass !== 'off_hand') {
    return fail('Weapon assigned to a non-weapon slot')
  }
  const expectedSlot = catalogSlot(id)
  if (!meta.weaponType && expectedSlot && toSlotClass(expectedSlot) !== slotClass) return fail('Item assigned to the wrong equipment slot')

  const enchant = get('enchant_id')
  const ilevel = get('ilevel')
  if (ilevel !== undefined && (!Number.isInteger(Number(ilevel)) || Number(ilevel) <= 0)) return fail('Item level must be a positive integer')
  const item: ItemString = {
    emittedSlot,
    tokens,
    id,
    bonusIds: numList(get('bonus_id')),
    gemIds: numList(get('gem_id')),
    enchantId: enchant ? Number(enchant) : undefined,
    ilvlOverride: ilevel ? Number(ilevel) : undefined
  }

  // Within-item limits apply to a typed item string exactly as they do to a
  // guided one. Both guided resolvers check this; the exact-import path did
  // not, so `gem_id=<x>/<x>` on a quantity-1 gem was accepted here and then
  // undercounted by the solver.
  try {
    assertGemCategoryLimits(item.gemIds)
  } catch (error) { return fail((error as Error).message) }

  return {
    candidate: {
      item,
      name: resolved?.label ?? (input.label?.trim() || catalogItem(id)?.name || `Item ${id}`),
      // Unknown advanced-import levels remain unknown. Explicit hypotheses
      // bypass the owned-bag floor rather than inventing a display level.
      ilvl: resolved?.ilvl ?? item.ilvlOverride ?? 0,
      slotClass: slotClass as SlotClass,
      source: 'hypothetical'
    },
    embellished: input.embellished
  }
}

export interface HypotheticalResult {
  accepted: HypotheticalCandidate[]
  rejected: HypotheticalError[]
}

export function parseHypotheticals(
  profile: Profile,
  inputs: readonly HypotheticalInput[]
): HypotheticalResult {
  const accepted: HypotheticalCandidate[] = []
  const rejected: HypotheticalError[] = []
  for (const input of inputs) {
    const parsed = parseHypothetical(profile, input)
    if ('reason' in parsed) rejected.push(parsed)
    else accepted.push(parsed)
  }
  return { accepted, rejected }
}

/** Declared embellishment flags, keyed by the candidate object identity. */
export type EmbellishmentDeclarations = ReadonlyMap<CandidateItem, boolean>

export function declarationsFrom(
  candidates: readonly HypotheticalCandidate[]
): EmbellishmentDeclarations {
  return new Map(candidates.flatMap((h) => h.embellished === undefined ? [] : [[h.candidate, h.embellished]]))
}
