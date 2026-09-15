import type { Profile } from '../types.ts'
import { catalogItem, catalogSlot } from './catalog.ts'
import { findCraftedRecipe } from './crafted.ts'
import { parseHypothetical, type ItemSelection } from '../topgear/hypothetical.ts'

export interface ItemPreviewRequest { id?: number; itemString?: string; selection?: ItemSelection }

/** A search result needs a concrete preview variant; never display allocation weights as stats. */
export function previewCandidate(profile: Profile, request: ItemPreviewRequest) {
  let selection = request.selection
  let itemString = request.itemString ?? ''
  let note: string | undefined
  if (!selection && !itemString) {
    const item = catalogItem(request.id ?? 0)
    const variant = item?.variants[0]
    const recipe = findCraftedRecipe(request.id ?? 0)
    if (variant && item) {
      selection = { itemId: item.id, track: variant.track, ilvl: variant.ilvl }
      note = `Preview: ${variant.track} ${variant.ilvl}. Select an item to configure its level.`
    } else if (recipe) {
      selection = { kind: 'crafted', itemId: recipe.itemId, ladderBonusId: recipe.ilvlLadder.at(-1)!.bonusId,
        craftingQuality: 5, craftedStats: [32, 36] }
      note = 'Preview: quality 5, Critical Strike / Haste. Choose two stats to customize.'
    } else {
      const slot = catalogSlot(request.id ?? 0)
      if (!slot) throw new Error('No equipment slot is known for this item')
      itemString = `${slot}=,id=${request.id}`
      note = 'Base item preview. No upgrade variant selected.'
    }
  }
  if (itemString.length > 4096 || /[\r\n]/.test(itemString)) throw new Error('Invalid item preview')
  // Reports use encoded_item without an equipment prefix.
  if (itemString && !/^[a-z0-9_]+=,/i.test(itemString)) {
    const id = Number(itemString.match(/(?:^|,)id=(\d+)/)?.[1])
    const slot = catalogSlot(id)
    if (!slot) throw new Error('No equipment slot is known for this item')
    itemString = `${slot}=,${itemString.startsWith('id=') ? itemString : itemString.replace(/^[^,]*,/, '')}`
  }
  const parsed = parseHypothetical(profile, { selection, itemString })
  if ('reason' in parsed) throw new Error(parsed.reason)
  return { candidate: parsed.candidate, note }
}
