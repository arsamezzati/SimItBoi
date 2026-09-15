/**
 * Real check for gem and eligible enchant configuration, plus
 * the guided crafting/embellishment guards. Run: npm run check:gear
 *
 * Echo is not proof: simc happily reprints tokens it ignored. So the gem and the
 * enchant are verified by *measuring* the stat change they cause, not by finding
 * their ids in the output.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveCatalog, searchCatalog, type CatalogSelection } from '../src/core/data/catalog.ts'
import { embellishments, enchantsForSlot, gems } from '../src/core/data/db2.ts'
import { resolveCrafted } from '../src/core/data/crafted.ts'
import { runSim } from '../src/core/simc/runner.ts'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { filterCandidates } from '../src/core/topgear/prepass.ts'
import { itemStatKey, probeItemStats } from '../src/core/data/itemStats.ts'

const raw = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
const CLASS = 'shaman'
const SIMC = 'vendor/simc/simc.exe'

interface GearEntry { ilevel: number; encoded_item: string; [stat: string]: number | string }
interface Player {
  gear: Record<string, GearEntry>
  collected_data: { buffed_stats: { attribute: Record<string, number>; stats: Record<string, number> } }
}

async function playerFor(itemString: string): Promise<Player> {
  const run = await runSim({
    simcPath: SIMC,
    input: `${raw}\n${itemString}\niterations=1\nthreads=1\nmax_time=10\n`,
    leanReport: true
  })
  return (run.json as { sim: { players: Player[] } }).sim.players[0]!
}

/**
 * Character stats, not the item row. simc does NOT fold a gem or enchant into
 * `gear.<slot>` — measured: adding a +Primary Stat gem leaves the finger1 entry
 * byte-identical while intellect moves 3466 -> 3492. Reading the item row would
 * have reported every gem as ignored.
 */
function statTotal(player: Player): number {
  const buffed = player.collected_data.buffed_stats
  return Object.values(buffed.attribute).reduce((a, b) => a + b, 0) +
    Object.values(buffed.stats).reduce((a, b) => a + b, 0)
}

// A socketed finger item is the one case that exercises all three at once.
const candidates = searchCatalog('', CLASS, 'finger').items.filter((i) => i.variants.length && i.sockets > 0)
assert.ok(candidates.length, 'no socketed finger item with track variants in the catalog')
const item = candidates[0]!
const variant = item.variants[0]!
const gemEntry = gems()[0]!
const gem = { name: gemEntry.name, effect: gemEntry.effect, id: gemEntry.tiers.at(-1)!.id }
const slotEnchants = enchantsForSlot('finger1')
assert.ok(slotEnchants.length, 'no enchants classified for finger')
const enchant = slotEnchants[0]!

console.log(`item:          ${item.name} #${item.id}, ${item.sockets} socket(s), ${variant.track} ${variant.ilvl}`)
console.log(`gem:           ${gem.name} — ${gem.effect}`)
console.log(`enchant:       ${enchant.name} (${enchant.tiers.length} quality tier(s))`)
console.log('')

const base = { itemId: item.id, track: variant.track, ilvl: variant.ilvl }
const plain = resolveCatalog(base, CLASS)
const gemmed = resolveCatalog({ ...base, gemIds: [gem.id] }, CLASS)
const enchanted = resolveCatalog({ ...base, enchantId: enchant.tiers.at(-1)!.id }, CLASS)

const plainPlayer = await playerFor(plain.itemString)
const gemmedPlayer = await playerFor(gemmed.itemString)
const enchantedPlayer = await playerFor(enchanted.itemString)

const plainStats = statTotal(plainPlayer)
console.log(`plain:     ${plainStats} total character stats`)
console.log(`+ gem:     ${statTotal(gemmedPlayer)} (${statTotal(gemmedPlayer) - plainStats > 0 ? '+' : ''}${statTotal(gemmedPlayer) - plainStats})`)
console.log(`+ enchant: ${statTotal(enchantedPlayer)} (${statTotal(enchantedPlayer) - plainStats > 0 ? '+' : ''}${statTotal(enchantedPlayer) - plainStats})`)

assert.ok(statTotal(gemmedPlayer) > plainStats, 'the gem changed nothing — simc ignored it')
assert.ok(statTotal(enchantedPlayer) > plainStats, 'the enchant changed nothing — simc ignored it')

// Refusals: nothing unvalidated reaches simc.
//
// Typed as partial selections rather than `as const`: the latter made each
// gemIds array `readonly`, which CatalogSelection does not accept. The values
// were always fine — the annotation was describing them wrongly.
const refusals: ReadonlyArray<readonly [string, Partial<CatalogSelection>]> = [
  ['unknown gem', { gemIds: [999_999] }],
  ['unknown enchant', { enchantId: 999_999 }],
  ['unknown embellishment', { embellishmentBonusId: 999_999 }],
  ['known embellishment on a guided track item', { embellishmentBonusId: embellishments()[0]!.bonusId }],
  ['crafted quality on a guided track item', { craftingQuality: 5 }],
  ['more gems than sockets', { gemIds: Array.from({ length: item.sockets + 1 }, () => gem.id) }]
]
for (const [name, selection] of refusals) {
  assert.throws(() => resolveCatalog({ ...base, ...selection }, CLASS), new RegExp('.'), `${name} was accepted`)
  console.log(`refused:  ${name}`)
}

assert.throws(
  () => resolveCatalog({ itemId: 250214, track: 'Hero', ilvl: 321, enchantId: enchant.tiers.at(-1)!.id }, CLASS),
  /cannot be applied.*slot/i,
  'ring enchant 7964 was accepted on trinket 250214'
)
console.log('refused:  ring enchant on a trinket')

// Exact hover identity: the same tier chest at two levels must produce two
// independently addressable real results, not one base-id entry.
const profile = parseAddonProfile(raw)
const chestVariants = filterCandidates(profile, { preserveVariants: true })
  .filter((candidate) => candidate.item.id === 271486)
assert.equal(chestVariants.length, 2, 'expected equipped and bag variants of item 271486')
const hoverStats = await probeItemStats(profile, chestVariants, { simcPath: SIMC })
const hoverResults = chestVariants.map((candidate) => hoverStats.get(itemStatKey(candidate)))
assert.equal(new Set(chestVariants.map(itemStatKey)).size, 2, '271486 variants share a hover key')
assert.ok(hoverResults.every((result) => result?.status === 'available'), 'a 271486 variant has no verified hover stats')
assert.notDeepEqual(hoverResults[0], hoverResults[1], '334/308 variants returned identical hover stats')
console.log('verified: 271486 at 334 and 308 has separate real hover stats')

// --- Crafted items --------------------------------------------------
// The base bonus is a measured constant, so re-measure it rather than trust it:
// without it a crafted item resolves at item level 46 instead of 331.
console.log('')
console.log('crafted items:')
for (const [itemId, ladderBonusId, expectedIlvl, stats] of [
  [244582, 12497, 331, [40, 32]],
  [244582, 12493, 318, [40, 32]],
  [240949, 12497, 331, [36, 49]]
] as const) {
  const resolved = resolveCrafted(
    { kind: 'crafted', itemId, ladderBonusId, craftingQuality: 5, craftedStats: [...stats] },
    CLASS
  )
  const player = await playerFor(resolved.itemString)
  const slot = resolved.itemString.split('=')[0]!
  const entry = player.gear[slot === 'wrist' ? 'wrists' : slot]
  assert.ok(entry, `simc rejected ${resolved.label}`)
  assert.equal(entry.ilevel, expectedIlvl, `${resolved.label}: simc says ${entry.ilevel}`)
  // The chosen stats must be the ones simc reports, not a bonus's own pair.
  const reported = Object.keys(entry).filter((k) => k.endsWith('_rating'))
  const names: Record<number, string> = { 32: 'crit_rating', 36: 'haste_rating', 40: 'versatility_rating', 49: 'mastery_rating' }
  for (const s of stats) {
    assert.ok(reported.includes(names[s]!), `${resolved.label}: expected ${names[s]}, got ${reported.join(', ')}`)
  }
  console.log(`  ${resolved.label.padEnd(52)} ilvl ${entry.ilevel}  ${reported.join(' ')}`)
}

// Embellishment eligibility, enforced from measured recipe slot coverage.
{
  const legs = { kind: 'crafted' as const, itemId: 244582, ladderBonusId: 12497, craftingQuality: 5, craftedStats: [40, 32] }
  const gun = embellishments().find((e) => e.appliesTo === 'guns')!
  assert.throws(() => resolveCrafted({ ...legs, embellishmentBonusId: gun.bonusId }, CLASS), /cannot be applied/)
  console.log(`  refused:  ${gun.name} on legs`)
  const armor = embellishments().find((e) => e.appliesTo === 'armor' && e.expansion === 'Midnight')!
  const embellished = resolveCrafted({ ...legs, embellishmentBonusId: armor.bonusId }, CLASS)
  const player = await playerFor(embellished.itemString)
  assert.ok(player.gear.legs?.encoded_item.includes('id=244582'), 'simc rejected the embellished crafted item')
  assert.equal(player.gear.legs!.ilevel, 331, 'the embellishment changed the item level')
  console.log(`  accepted: ${armor.name} on legs, still ilvl 331`)
}

console.log('\nAll gear configuration checks passed.')
