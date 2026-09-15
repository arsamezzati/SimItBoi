/** Real simulator checks: numeric stat equality, not merely echoed redirection tokens. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { catalog, catalystTarget, resolveCatalog } from '../src/core/data/catalog.ts'
import { runSim } from '../src/core/simc/runner.ts'
const raw = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
interface Gear { name:string; encoded_item:string; ilevel:number; [key:string]:string|number }
async function gear(line:string, slot:string): Promise<Gear> {
  const r=await runSim({simcPath:'vendor/simc/simc.exe',input:`${raw}\n${line}\niterations=1\nmax_time=1\nthreads=1\n`,leanReport:true})
  return (r.json as {sim:{players:{gear:Record<string,Gear>}[]}}).sim.players[0].gear[slot === 'shoulder' ? 'shoulders' : slot]
}
const numeric = (g:Gear): Record<string,number> => Object.fromEntries(Object.entries(g).filter((e): e is [string,number] => typeof e[1] === 'number'))
for (const slot of ['head','shoulder','chest','hands','legs']) {
  const item=catalog().items.find(i=> i.slot===slot && catalystTarget(i,'shaman'))!
  for (const level of [308,334]) {
    const base={itemId:item.id,track:level===308?'Hero':'Myth',ilvl:level}
    const plain=resolveCatalog(base,'shaman')
    const converted=resolveCatalog({...base,catalyst:true},'shaman')
    const before=await gear(plain.itemString,slot)
    const after=await gear(converted.itemString,slot)
    assert.deepEqual(numeric(after),numeric(before),`${item.name} at ${level}: catalyst changed stats`)
    assert.notEqual(after.name,before.name)
    console.log(`${slot} ${item.id} @ ${level}: tier identity; original numeric stats retained`)
  }
}
const base={itemId:251233,track:'Myth',ilvl:334,enchantId:7987}
const before=await gear(resolveCatalog(base,'shaman').itemString,'chest')
const after=await gear(resolveCatalog({...base,catalyst:true},'shaman').itemString,'chest')
assert.deepEqual(numeric(after),numeric(before))
assert.match(after.encoded_item,/enchant_id=7987/)
console.log('Catalyst: 10 slot/level pairs plus enchanted chest passed')
