import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { previewCandidate } from '../src/core/data/itemPreview.ts'
import { craftedRecipes } from '../src/core/data/crafted.ts'
const profile = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
test('unsimmed catalog and craft previews have explicit default variants', () => {
  const drop = previewCandidate(profile, { id: 251233 })
  assert.equal(drop.candidate.ilvl, 266)
  assert.match(drop.note!, /Adventurer 266/)
  const craft = previewCandidate(profile, { id: 244582 })
  assert.equal(craft.candidate.item.tokens.find(t => t.key === 'crafted_stats')?.value, '32/36')
  assert.match(craft.note!, /Critical Strike \/ Haste/)
})
test('preview preserves exact imported variants and rejects injected lines', () => {
  const encoded = 'fanged_raiment,id=271486,bonus_id=12854,redirected_base_stats=251233'
  const result = previewCandidate(profile, { itemString: encoded })
  assert.equal(result.candidate.item.tokens.find(t => t.key === 'redirected_base_stats')?.value, '251233')
  assert.throws(() => previewCandidate(profile, { itemString: `${encoded}\niterations=999999` }), /Invalid item preview/)
  assert.throws(() => previewCandidate(profile, { id: -1 }))
})
test('every guided crafted recipe has bundled real icon artwork', () => {
  const icons = JSON.parse(readFileSync('src/renderer/src/item-icons.json', 'utf8'))
  for (const recipe of craftedRecipes()) {
    const icon = icons[recipe.itemId]
    assert.ok(icon, `${recipe.itemId} missing icon mapping`)
    assert.ok(existsSync(`src/renderer/public/item-icons/${icon}.jpg`), `${recipe.itemId} missing icon file`)
  }
})
