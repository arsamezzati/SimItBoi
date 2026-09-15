/**
 * Embellishment detection.
 *
 * A character may wear at most **2 embellishments** — `ItemLimitCategory` 512
 * "Embellished", quantity 2, which is the game's own number rather than a
 * constant we chose.
 *
 * THIS IS NOW A MEASUREMENT. It used to be a proxy — crafted epics were counted
 * as embellished, because nothing available identified a real embellishment.
 * The DB2 dump closes that: one bonus list assigns the Embellished
 * limit category, and an item carries it **iff** it is embellished. Reading it
 * costs nothing — the bonus ids are already in the item string.
 *
 * The old proxy over-counted plain crafted epics, costing search depth. Dropping
 * it means the cap now binds on exactly the items the game would bind it on.
 */
import type { CandidateItem } from '../types.ts'
import { isEmbellishedByBonus, limitCategoryFor } from './db2.ts'

/** Embellishments contributed by one item: 1 when it carries the marker. */
export function embellishmentCount(
  c: CandidateItem,
  declared?: ReadonlyMap<CandidateItem, boolean>
): number {
  // The game's own marker, read straight off the item string. This is
  // a measurement, not the proxy it replaces: the bonus list that assigns the
  // Embellished limit category is exactly what makes the cap bind in game.
  if (isEmbellishedByBonus(c.item.bonusIds)) return 1
  // A declaration still covers advanced-import items whose bonus ids the user
  // typed themselves, and items from a build the bundled table predates.
  const declaration = declared?.get(c)
  if (declaration !== undefined) return declaration ? 1 : 0
  return 0
}

/** The game's cap, and the value the solver already enforces. */
export const MAX_EMBELLISHMENTS = 2

/**
 * Restriction provider for `solveTopGear({ restrictions })`.
 *
 * Must return a value for every item — the solver treats `undefined` as missing
 * metadata and excludes the item.
 */
export function equipmentRestrictions(
  c: CandidateItem,
  declared?: ReadonlyMap<CandidateItem, boolean>
): {
  categories: readonly { key: string; limit: number; uses: number }[]
  embellishments: number
} {
  // Cross-item category membership, now that the DB2 table carries it.
  // An item consumes a unit for its own category and for each category its gems
  // belong to, so two rings each holding a quantity-1 gem cannot both be worn.
  //
  // `uses` is what an item consumes, which is not always one: two gems of the
  // same category in one item consume two. Collapsing them to a single entry
  // is what let a neck wear the same quantity-1 gem twice.
  const limits = new Map<string, number>()
  const uses = new Map<string, number>()
  for (const id of [c.item.id, ...c.item.gemIds]) {
    const category = limitCategoryFor(id)
    if (!category) continue
    const key = String(category.id)
    limits.set(key, category.quantity)
    uses.set(key, (uses.get(key) ?? 0) + 1)
  }
  return {
    categories: [...limits].map(([key, limit]) => ({ key, limit, uses: uses.get(key) ?? 1 })),
    embellishments: embellishmentCount(c, declared)
  }
}

/** Binds declarations so the result matches `SolverOptions.restrictions`. */
export function restrictionsWith(declared?: ReadonlyMap<CandidateItem, boolean>) {
  return (c: CandidateItem): ReturnType<typeof equipmentRestrictions> =>
    equipmentRestrictions(c, declared)
}
