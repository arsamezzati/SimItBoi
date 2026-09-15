import { lookupItem, itemTable } from '../src/core/data/itemTable.ts'
const t = itemTable()
console.log('set 2065 members:', t.sets['2065'].items.join(', '))
for (const id of [271481, 271482, 271483, 271484, 271485, 271486]) {
  const m = lookupItem(id)
  console.log(String(id), m ? `${m.inventoryType.padEnd(10)} sub=${m.itemSubclassId} set=${m.setId ?? 'NONE'}` : 'not in table')
}
const hits = Object.entries(t.sets).filter(([, s]) => s.items.includes(271485))
console.log('\nsets containing 271485 (equipped feet):', hits.length ? hits.map(([id, s]) => `${id} ${s.name}`).join(', ') : 'NONE')
