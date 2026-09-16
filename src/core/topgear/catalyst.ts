/**
 * Catalyst versions of gear the character already owns.
 *
 * In Season 2 a converted piece keeps the item level and the stat split of the
 * item it was made from, and gains the tier set's identity — which is why the
 * same tier item id shows up with different stats on different characters.
 * A tier piece won from a raid token instead carries its own fixed split.
 *
 * So the useful question for Top Gear is "which of my pieces is worth
 * converting", and that is a transformation of items the character owns: same
 * bonus ids, same gems and enchant, tier item id, and `redirected_base_stats`
 * naming the original. Nothing here invents an item level or an upgrade track.
 */
import { emitItemString } from '../parser/addonProfile.ts'
import { catalogItem, catalystTarget } from '../data/catalog.ts'
import { lookupItem } from '../data/itemTable.ts'
import type { CandidateItem, Profile } from '../types.ts'
import type { HypotheticalInput } from './hypothetical.ts'

/** Tokens copied onto the converted piece; the rest belong to the original item. */
const CARRIED = new Set(['bonus_id', 'gem_id', 'enchant_id'])

/** The converted twin of one owned item, or null when it cannot be converted. */
export function catalystTwin(profile: Profile, owned: CandidateItem): HypotheticalInput | null {
  const item = catalogItem(owned.item.id)
  if (!item) return null
  // Crafted gear has no catalyst conversion, and a piece that is already tier
  // cannot be converted again.
  if (owned.item.tokens.some((t) => t.key === 'crafted_stats' || t.key === 'crafted_quality')) return null
  if (lookupItem(owned.item.id)?.setId) return null
  const tier = catalystTarget(item, profile.className)
  if (!tier) return null

  const tokens = owned.item.tokens.filter((t) => CARRIED.has(t.key))
  const bonuses = [...new Set([
    ...(tokens.find((t) => t.key === 'bonus_id')?.value.split('/').filter(Boolean) ?? []),
    ...tier.bonusIds.map(String)
  ])]
  const parts = [
    'id=' + tier.id,
    ...(bonuses.length ? ['bonus_id=' + bonuses.join('/')] : []),
    ...tokens.filter((t) => t.key !== 'bonus_id').map((t) => t.key + '=' + t.value),
    'redirected_base_stats=' + owned.item.id
  ]
  return {
    itemString: emitItemString({ ...owned.item, tokens: [] }, owned.item.emittedSlot).split('=,')[0] + '=,' + parts.join(','),
    label: tier.name + ' · Catalyst from ' + (owned.name || 'item ' + owned.item.id)
  }
}

/**
 * Every conversion available to this character, newest gear first. One per
 * owned piece: the same item converted twice would be the same candidate.
 */
export function catalystOptions(profile: Profile): HypotheticalInput[] {
  const seen = new Set<string>()
  const twins: HypotheticalInput[] = []
  for (const owned of [...profile.equipped, ...profile.bagItems].sort((a, b) => b.ilvl - a.ilvl)) {
    const twin = catalystTwin(profile, owned)
    if (!twin || seen.has(twin.itemString)) continue
    seen.add(twin.itemString)
    twins.push(twin)
  }
  return twins
}
