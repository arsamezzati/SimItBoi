/**
 * Average equipped item level, the way the game's character sheet counts it.
 *
 * Sixteen slots, an empty one counting as zero. A two-handed weapon with the
 * off hand empty counts twice, since it fills both hands; a one-hander alone
 * does not. Tabard and shirt are cosmetic and never parsed as gear.
 */
import type { CandidateItem } from './types.ts'
import { lookupItem } from './data/itemTable.ts'

const EQUIPPED_SLOTS = 16
const TWO_HANDED = new Set(['TWOHWEAPON', 'RANGED'])

export function averageItemLevel(equipped: readonly CandidateItem[]): number | null {
  const withLevel = equipped.filter((c) => c.ilvl > 0)
  if (withLevel.length === 0) return null
  let total = withLevel.reduce((sum, c) => sum + c.ilvl, 0)
  const mainHand = withLevel.find((c) => c.item.emittedSlot === 'main_hand')
  const offHand = withLevel.some((c) => c.item.emittedSlot === 'off_hand')
  if (mainHand && !offHand && TWO_HANDED.has(lookupItem(mainHand.item.id)?.inventoryType ?? '')) total += mainHand.ilvl
  return total / EQUIPPED_SLOTS
}
