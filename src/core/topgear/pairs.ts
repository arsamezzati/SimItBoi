import type { CandidateItem } from '../types.ts'
import { emitItemString } from '../parser/addonProfile.ts'
import { uniqueRuleFor } from '../data/itemTable.ts'
import { satisfiesUniqueRules, type UniqueRule } from '../data/unique.ts'

/**
 * M6 paired-slot building block. Each array entry is one owned physical copy.
 * Do not feed this the pre-pass's same-id-deduplicated candidate pool: variants
 * and duplicate copies must survive until after legal pairs are constructed.
 */
export function* enumerateItemPairs(
  candidates: readonly CandidateItem[],
  lookup: (c: CandidateItem) => UniqueRule | undefined = uniqueRuleFor
): Generator<readonly [CandidateItem, CandidateItem]> {
  const seen = new Set<string>()
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]
      const b = candidates[j]
      if (a === b || a.slotClass !== b.slotClass || !['finger', 'trinket'].includes(a.slotClass)) continue
      if (!satisfiesUniqueRules([a, b].map((c) => ({ id: c.item.id, rule: lookup(c) })))) continue
      // Ignore original position, preserve every item-string token. Swapping
      // two identical physical copies does not create another gear combination.
      const key = JSON.stringify([emitItemString(a.item, 'slot'), emitItemString(b.item, 'slot')].sort())
      if (seen.has(key)) continue
      seen.add(key)
      yield [a, b]
    }
  }
}
