import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { catalog, catalystTarget, resolveCatalog, searchCatalog } from '../src/core/data/catalog.ts'
import { lookupItem } from '../src/core/data/itemTable.ts'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { parseHypothetical } from '../src/core/topgear/hypothetical.ts'

test('catalyst resolves class tier identity and retains source stats, track and enchant', () => {
  const selection = { itemId: 251233, track: 'Myth', ilvl: 334, enchantId: 7987, catalyst: true }
  const converted = resolveCatalog(selection, 'shaman')
  assert.match(converted.itemString, /^chest=,id=271486,/)
  assert.match(converted.itemString, /redirected_base_stats=251233/)
  assert.match(converted.itemString, /enchant_id=7987/)
  assert.match(converted.itemString, /12854/)
  assert.equal(converted.ilvl, 334)
  assert.match(converted.label, /Catalyst from Manipulator's Vest/)
  const profile = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  const restored = parseHypothetical(profile, JSON.parse(JSON.stringify({ selection, itemString: 'chest=,id=1' })))
  assert.ok(!('reason' in restored))
  assert.equal(lookupItem(restored.candidate.item.id)?.setId, 2065, 'solver must see class tier membership')
  assert.equal(restored.candidate.item.tokens.find(t => t.key === 'redirected_base_stats')?.value, '251233')
  assert.doesNotMatch(resolveCatalog({...selection, catalyst: false}, 'shaman').itemString, /redirected_base_stats/)
})

test('each class has unambiguous Season 2 tier targets for all five slots', () => {
  for (const className of ['warrior','paladin','hunter','rogue','priest','deathknight','shaman','mage','warlock','monk','druid','demonhunter','evoker']) {
    for (const slot of ['head','shoulder','chest','hands','legs']) {
      const source = catalog().items.find(i => i.slot === slot && catalystTarget(i, className))
      assert.ok(source, `${className} ${slot}`)
      const target = catalystTarget(source, className)!
      assert.equal(target.slot, slot)
      assert.equal(target.season, 2)
      assert.ok(lookupItem(target.id)?.setId)
      const variant = source.variants[0]
      assert.match(resolveCatalog({itemId: source.id, track: variant.track, ilvl: variant.ilvl, catalyst:true},className).itemString, new RegExp(`id=${target.id},`))
    }
  }
})

test('catalyst rejects non-tier slots, already-tier, old-season, wrong-class and malformed requests', () => {
  for (const itemId of [250214, 271486, 271485, 251233]) {
    assert.throws(() => resolveCatalog({itemId, track:'Myth', ilvl:334, catalyst:true}, itemId === 251233 ? 'mage' : 'shaman'))
  }
  const old = catalog().items.find(i => i.season === 1)!
  assert.equal(catalystTarget(old,'shaman'),undefined)
  assert.throws(() => resolveCatalog({itemId:251233,track:'Myth',ilvl:334,catalyst:'yes' as unknown as boolean},'shaman'), /Invalid catalyst/)
  assert.equal(searchCatalog('251233','shaman').items[0].catalystTarget?.id,271486)
  assert.equal(searchCatalog('250214','shaman').items[0].catalystTarget,undefined)
})
