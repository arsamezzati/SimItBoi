/**
 * Generates the DB2-derived table: embellishments, item limit categories and
 * enchants.
 *
 * Run: npm run build:db2                  (uses the cache)
 *      npm run build:db2 -- --refresh     (re-downloads)
 *
 * BUILD TIME ONLY. Like the Blizzard item table, the output ships with
 * the app and the runtime never touches the network.
 *
 * Source: wago.tools CSV exports, pinned to one game build. Raw CSVs are cached
 * under .cache/db2/<build>/ and never re-downloaded: a pinned build's tables do
 * not change, and they are large — SpellName alone is 11 MB. Only the small
 * derived table is committed.
 */
import { mkdir, writeFile, rename, readFile, access } from 'node:fs/promises'
import { dirname } from 'node:path'

const args = new Set(process.argv.slice(2))
const REFRESH = args.has('--refresh')
/** Pinned to the client build the vendored simc reports. */
const BUILD = process.env['DB2_BUILD'] ?? '12.1.0.69587'
/** 11 = Midnight. Verified against fixture #1's own gems, neck and crafted legs. */
const CURRENT_EXPANSION = process.env['DB2_EXPANSION'] ?? '11'
const CACHE = `.cache/db2/${BUILD}`
const OUT = process.env['DB2_OUT'] ?? 'src/core/data/db2.json'

type Row = Record<string, string>

/** Full CSV parse — names carry commas and escaped quotes, so splitting fails. */
function parseCsv(text: string): Row[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  const head = rows.shift()
  if (!head) throw new Error('Empty CSV')
  return rows
    .filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(r.map((v, i) => [head[i]!, v])))
}

/**
 * Row-at-a-time parse for the large tables. ItemSparse is 175k rows of 130
 * columns; materialising that as objects costs gigabytes for the eight fields
 * we actually want, so the caller picks columns and gets arrays.
 */
function scanCsv(text: string, columns: readonly string[], onRow: (values: string[]) => void): void {
  let head: string[] | null = null
  let want: number[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const commit = (r: string[]): void => {
    if (!head) {
      head = r
      want = columns.map((c) => {
        const i = head!.indexOf(c)
        if (i < 0) throw new Error(`Column ${c} not found`)
        return i
      })
      return
    }
    onRow(want.map((i) => r[i] ?? ''))
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      commit(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (row.length || field) {
    row.push(field)
    commit(row)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Raw CSV text, from the cache when present. */
async function csv(name: string): Promise<string> {
  const path = `${CACHE}/${name}.csv`
  if (!REFRESH && (await exists(path))) {
    const text = await readFile(path, 'utf8')
    console.log(`  ${name}: cached (${(text.length / 1e6).toFixed(1)} MB)`)
    return text
  }
  const res = await fetch(`https://wago.tools/db2/${name}/csv?build=${BUILD}`)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} for build ${BUILD}`)
  const text = await res.text()
  await mkdir(CACHE, { recursive: true })
  await writeFile(`${path}.tmp`, text, 'utf8')
  await rename(`${path}.tmp`, path)
  console.log(`  ${name}: downloaded (${(text.length / 1e6).toFixed(1)} MB cached)`)
  return text
}

async function table(name: string): Promise<Row[]> {
  return parseCsv(await csv(name))
}

/** Streams one of the large tables, keeping only `columns`. */
async function scan(name: string, columns: readonly string[], onRow: (v: string[]) => void): Promise<void> {
  scanCsv(await csv(name), columns, onRow)
}

console.log(`DB2 build ${BUILD}${REFRESH ? ' (forced refresh)' : ''}`)
const limitCategories = await table('ItemLimitCategory')
const itemBonus = await table('ItemBonus')
const treeNodes = await table('ItemBonusTreeNode')
const itemEffects = await table('ItemEffect')
const spellNames = await table('SpellName')
const enchantRows = await table('SpellItemEnchantment')
const craftingQualities = await table('CraftingQuality')

// --- Icons ----------------------------------------------------------------
// Every source gives a FileDataID; the app's icon pack is keyed by name, the
// way the season gear inventory already keys it (build-season-gear.ts). This is the
// only table that maps one to the other.
const iconNameOf = new Map<string, string>()
await scan('ManifestInterfaceData', ['ID', 'FilePath', 'FileName'], ([id, path, file]) => {
  if (!/^interface\\icons\\$/i.test(path ?? '')) return
  iconNameOf.set(id!, (file ?? '').replace(/\.blp$/i, '').toLowerCase())
})

/** Icon name for a FileDataID, or null when it is not an interface icon. */
function iconFor(fileDataId: string | undefined): string | null {
  if (!fileDataId || fileDataId === '0') return null
  return iconNameOf.get(fileDataId) ?? null
}

/** CraftingQuality ids are not tiers: id 14 is tier 2. */
const tierOfCraftingQuality = new Map(craftingQualities.map((q) => [q['ID']!, Number(q['QualityTier'])]))

const spellIcon = new Map<string, string>()
await scan('SpellMisc', ['SpellID', 'SpellIconFileDataID'], ([spellId, icon]) => {
  if (spellId && icon && icon !== '0' && !spellIcon.has(spellId)) spellIcon.set(spellId, icon)
})

// --- Embellishments -------------------------------------------------------
// The marker is derived, never hardcoded, so a build that renumbers it still
// resolves.
const embellishedCategory = limitCategories.find((c) => c['Name_lang'] === 'Embellished')
if (!embellishedCategory) throw new Error('No ItemLimitCategory named "Embellished"')
const categoryId = embellishedCategory['ID']!
const markerRow = itemBonus.find((b) => b['Type'] === '35' && b['Value_0'] === categoryId)
if (!markerRow) throw new Error(`No bonus list assigns limit category ${categoryId}`)
const marker = Number(markerRow['ParentItemBonusListID'])

const bonusByList = new Map<string, Row[]>()
for (const b of itemBonus) {
  const key = b['ParentItemBonusListID']!
  const list = bonusByList.get(key)
  if (list) list.push(b)
  else bonusByList.set(key, [b])
}
const spellOfEffect = new Map(itemEffects.map((e) => [e['ID']!, e['SpellID']!]))
const nameOfSpell = new Map(spellNames.map((s) => [s['ID']!, s['Name_lang']!]))

const trees = [
  ...new Set(
    treeNodes
      .filter((n) => n['ChildItemBonusListID'] === String(marker))
      .map((n) => n['ParentItemBonusTreeID']!)
  )
]
/**
 * Which equipment an embellishment may go on. The restriction is
 * carried by the crafting category the embellishment belongs to; the category's
 * own description states it in prose, which is what this classifies. The
 * category ID beside it is exact, so a later structural rule can replace this
 * without re-deriving the join.
 */
function appliesTo(description: string): string {
  const d = description.toLowerCase()
  if (d.includes('weapons and off-hands')) return 'weapons_offhands'
  if (d.includes('weapons and armor')) return 'weapons_armor'
  if (d.includes('guns')) return 'guns'
  if (d.includes('weapons')) return 'weapons'
  if (d.includes('accessories')) return 'accessories'
  if (d.includes('armor and accessory')) return 'armor_accessories'
  if (d.includes('leather and mail')) return 'leather_mail'
  if (d.includes('armor')) return 'armor'
  if (d.includes('equipment')) return 'equipment'
  return 'unknown'
}

/** Content scope, so current-expansion embellishments can be told apart. */
function expansionOf(description: string): string {
  if (/midnight/i.test(description)) return 'Midnight'
  if (/khaz algar/i.test(description)) return 'Khaz Algar'
  if (/dragon isles/i.test(description)) return 'Dragon Isles'
  return 'unknown'
}

// Embellishment -> crafting category -> reagent item. Both joins are exact.
const categoryRows = await table('ModifiedCraftingCategory')
const reagentRows = await table('ModifiedCraftingReagentItem')
const craftingItems = await table('ModifiedCraftingItem')
const categoryById = new Map(categoryRows.map((c) => [c['ID']!, c]))
const reagentByTree = new Map(
  reagentRows.filter((r) => r['ItemBonusTreeID'] !== '0').map((r) => [r['ItemBonusTreeID']!, r])
)
const itemsByReagent = new Map<string, string[]>()
for (const row of craftingItems) {
  const key = row['ModifiedCraftingReagentItemID']!
  const list = itemsByReagent.get(key)
  if (list) list.push(row['ItemID']!)
  else itemsByReagent.set(key, [row['ItemID']!])
}

interface EmbellishmentRow {
  bonusId: number; spellId: number; name: string; icon: string | null
  categoryId: number | null; category: string | null
  /** The game's own wording of the restriction; kept verbatim as evidence. */
  categoryNote: string | null
  appliesTo: string; expansion: string
  reagentItemId: number | null
}
const embellishments = new Map<number, EmbellishmentRow>()
let unnamed = 0
for (const tree of trees) {
  const siblings = treeNodes.filter(
    (n) =>
      n['ParentItemBonusTreeID'] === tree &&
      n['ChildItemBonusListID'] !== String(marker) &&
      n['ChildItemBonusListID'] !== '0'
  )
  for (const sibling of siblings) {
    const listId = sibling['ChildItemBonusListID']!
    const effect = (bonusByList.get(listId) ?? []).find((b) => b['Type'] === '23')
    if (!effect) continue
    const spellId = spellOfEffect.get(effect['Value_0']!)
    const name = spellId ? nameOfSpell.get(spellId) : undefined
    if (!spellId || !name) {
      unnamed++
      continue
    }
    const reagent = reagentByTree.get(tree)
    const category = reagent ? categoryById.get(reagent['ModifiedCraftingCategoryID']!) : undefined
    const note = category?.['Description_lang'] ?? ''
    const reagentItems = reagent ? itemsByReagent.get(reagent['ID']!) ?? [] : []
    embellishments.set(Number(listId), {
      bonusId: Number(listId),
      spellId: Number(spellId),
      name,
      icon: iconFor(spellIcon.get(spellId)),
      categoryId: category ? Number(category['ID']) : null,
      category: category?.['DisplayName_lang'] ?? null,
      categoryNote: note || null,
      appliesTo: appliesTo(note),
      expansion: expansionOf(note),
      reagentItemId: reagentItems.length ? Number(reagentItems[0]) : null
    })
  }
}

// --- Sockets --------------------------------------------------------------
// Two sources, and missing either gets the picker wrong. ItemSparse carries only
// *innate* sockets — fixture #1's neck has none, yet the profile gems it. That
// socket is granted by a bonus list instead: ItemBonus Type=6, Value_0 = count,
// Value_1 = socket type. Bonus 13668 appears on exactly the three fixture items
// that carry a gem, and on none that do not.
const socketBonusIds: Record<string, { count: number; socketType: number }> = {}
for (const b of itemBonus) {
  if (b['Type'] !== '6') continue
  socketBonusIds[b['ParentItemBonusListID']!] = {
    count: Number(b['Value_0']),
    socketType: Number(b['Value_1'])
  }
}

// --- Gems -----------------------------------------------------------------
// A gem is any item with Gem_properties set; its stat text comes from the
// enchantment that the gem applies. Scoped to current content by ExpansionID.
const gemEnchantOf = new Map<string, { enchantId: string; type: string }>()
for (const g of await table('GemProperties')) {
  gemEnchantOf.set(g['ID']!, { enchantId: g['Enchant_ID']!, type: g['Type']! })
}
const enchantNameById = new Map(enchantRows.map((e) => [e['ID']!, e['Name_lang'] ?? '']))

interface RawGem { id: number; name: string; quality: number; socketType: number; effect: string }
/** item id -> ItemLimitCategory id, for current-content items that have one. */
const itemLimitCategory: Record<string, number> = {}
const rawGems: RawGem[] = []
const innateSockets: Record<string, number[]> = {}
let currentItems = 0
/** Name, slot and scope for every current item, reused by the crafted walk. */
const craftedMeta = new Map<string, { name: string; inventoryType: string; expansion: string }>()
await scan(
  'ItemSparse',
  ['ID', 'ExpansionID', 'Display_lang', 'OverallQualityID', 'Gem_properties', 'SocketType_0', 'SocketType_1', 'SocketType_2', 'InventoryType', 'LimitCategory'],
  ([id, expansion, name, quality, gemProps, s0, s1, s2, inventoryType, limitCategory]) => {
    if (expansion !== CURRENT_EXPANSION) return
    // Membership in an ItemLimitCategory. Without it the shipped category names
    // and quantities cannot be enforced: two copies of a quantity-1 gem in one
    // item resolved happily before this was carried through.
    if (limitCategory && limitCategory !== '0') itemLimitCategory[id!] = Number(limitCategory)
    craftedMeta.set(id!, { name: name ?? '', inventoryType: inventoryType ?? '0', expansion: expansion! })
    currentItems++
    const sockets = [s0, s1, s2].map(Number).filter((s) => s > 0)
    if (sockets.length) innateSockets[id!] = sockets
    if (!gemProps || gemProps === '0') return
    const props = gemEnchantOf.get(gemProps)
    if (!props) return
    rawGems.push({
      id: Number(id),
      name: name ?? '',
      quality: Number(quality),
      socketType: Number(props.type),
      effect: statText(enchantNameById.get(props.enchantId) ?? '')
    })
  }
)

// Icon and crafting tier live in Item, not ItemSparse. Only gems are kept.
const gemIdSet = new Set(rawGems.map((g) => String(g.id)))
const gemIcon = new Map<string, string | null>()
const gemTier = new Map<string, number>()
await scan('Item', ['ID', 'IconFileDataID', 'CraftingQualityID'], ([id, icon, quality]) => {
  if (!gemIdSet.has(id!)) return
  gemIcon.set(id!, iconFor(icon))
  gemTier.set(id!, tierOfCraftingQuality.get(quality ?? '') ?? 0)
})

/**
 * One entry per gem, with its crafting tiers as choices. Two item ids share each
 * gem name — they are quality tiers, not different gems, and listing both made
 * the picker look like it had duplicates.
 */
const gems = [...rawGems.reduce((acc, g) => {
  const key = `${g.name}|${g.effect}`
  const entry = acc.get(key) ?? { name: g.name, effect: g.effect, quality: g.quality, socketType: g.socketType, tiers: [] as Array<{ id: number; tier: number; icon: string | null }> }
  entry.tiers.push({ id: g.id, tier: gemTier.get(String(g.id)) ?? 0, icon: gemIcon.get(String(g.id)) ?? null })
  acc.set(key, entry)
  return acc
}, new Map<string, { name: string; effect: string; quality: number; socketType: number; tiers: Array<{ id: number; tier: number; icon: string | null }> }>()).values()]
  .map((g) => ({ ...g, tiers: g.tiers.sort((a, b) => a.tier - b.tier || a.id - b.id) }))

// --- Class weapon proficiency ---------------------------------------------
// Class/spec weapon proficiencies are in neither the Blizzard API nor simc, but
// they are in this dump: SkillLine categories
// 6 (weapon skills) and 8 (armour, shield) joined to SkillRaceClassInfo.ClassMask.
//
// This matters because nothing else expresses it. A spec rule says whether a
// two-hander is allowed, never which kind — so a shadow priest, who may wield a
// staff but not a two-handed sword, was equally offered both.
const WEAPON_SKILL_SUBCLASS: Record<string, number[]> = {
  Axes: [0], 'Two-Handed Axes': [1], Bows: [2], Guns: [3], Maces: [4],
  'Two-Handed Maces': [5], Polearms: [6], Swords: [7], 'Two-Handed Swords': [8],
  Warglaives: [9], Staves: [10], 'Fist Weapons': [13], Daggers: [15],
  Crossbows: [18], Wands: [19]
}
/** Bit order of ClassMask, matching the game's class ids. */
const CLASS_BITS = [
  'warrior', 'paladin', 'hunter', 'rogue', 'priest', 'deathknight', 'shaman',
  'mage', 'warlock', 'monk', 'druid', 'demonhunter', 'evoker'
]

const skillNameById = new Map<string, string>()
for (const row of await table('SkillLine')) {
  // 6 = weapon skills, 8 = armour and shield proficiency.
  if (row['CategoryID'] === '6' || row['CategoryID'] === '8') {
    skillNameById.set(row['ID']!, row['DisplayName_lang'] ?? '')
  }
}
const weaponProficiency: Record<string, number[]> = {}
const shieldProficiency: string[] = []
{
  const bySkill = new Map<string, Set<number>>(CLASS_BITS.map((c) => [c, new Set<number>()]))
  for (const row of await table('SkillRaceClassInfo')) {
    const name = skillNameById.get(row['SkillID']!)
    if (!name) continue
    const mask = Number(row['ClassMask'])
    CLASS_BITS.forEach((cls, bit) => {
      if (mask !== -1 && !(mask & (1 << bit))) return
      if (name === 'Shield') { if (!shieldProficiency.includes(cls)) shieldProficiency.push(cls); return }
      for (const subclass of WEAPON_SKILL_SUBCLASS[name] ?? []) bySkill.get(cls)!.add(subclass)
    })
  }
  for (const [cls, subclasses] of bySkill) weaponProficiency[cls] = [...subclasses].sort((a, b) => a - b)
}

// --- Craftable items ------------------------------------------------------
// Which items have a recipe at all. The chain is exact:
//   recipe spell -> SpellEffect Effect=288 -> CraftingData -> CraftedItemID
// Verified: CraftingData 167 resolves to "Primal Molten Breastplate", matching
// its own recipe spell's name, and both of fixture #1's crafted items resolve
// to their recipes. This says an item IS craftable; it does not say what the
// recipe's base bonuses are.
const INVENTORY_SLOT: Record<string, string> = {
  '1': 'head', '2': 'neck', '3': 'shoulder', '5': 'chest', '6': 'waist', '7': 'legs',
  '8': 'feet', '9': 'wrist', '10': 'hands', '11': 'finger', '12': 'trinket',
  '13': 'one_hand', '14': 'shield', '15': 'ranged', '16': 'back', '17': 'two_hand',
  '20': 'chest', '21': 'main_hand', '22': 'off_hand', '23': 'holdable', '26': 'ranged'
}

const craftingData = new Map<string, { item: string; tree: string }>()
for (const row of await table('CraftingData')) {
  craftingData.set(row['ID']!, { item: row['CraftedItemID'] ?? '0', tree: row['ItemBonusTreeID'] ?? '0' })
}

/** Recipes that offer an "Add Embellishment" reagent slot, and which slot. */
const embellishSlotOfRecipe = new Map<string, string>()
{
  const embSlotIds = new Set(
    (await table('ModifiedCraftingReagentSlot'))
      .filter((r) => r['Name_lang'] === 'Add Embellishment')
      .map((r) => r['ID']!)
  )
  for (const row of await table('ModifiedCraftingSpellSlot')) {
    const slotId = row['ModifiedCraftingReagentSlotID']!
    if (embSlotIds.has(slotId)) embellishSlotOfRecipe.set(row['SpellID']!, slotId)
  }
}

interface CraftedItem {
  itemId: number; name: string; slot: string
  recipeSpellId: number
  /** The reagent slot that decides which embellishments this recipe accepts. */
  embellishmentSlotId: number | null
}
const craftedItems: CraftedItem[] = []
await scan('SpellEffect', ['SpellID', 'Effect', 'EffectMiscValue_0'], ([spellId, effect, misc]) => {
  if (effect !== '288') return
  const data = craftingData.get(misc ?? '')
  if (!data || data.item === '0') return
  const meta = craftedMeta.get(data.item)
  if (!meta || meta.expansion !== CURRENT_EXPANSION) return
  const slot = INVENTORY_SLOT[meta.inventoryType]
  if (!slot) return
  craftedItems.push({
    itemId: Number(data.item),
    name: meta.name,
    slot,
    recipeSpellId: Number(spellId),
    embellishmentSlotId: embellishSlotOfRecipe.has(spellId!) ? Number(embellishSlotOfRecipe.get(spellId!)) : null
  })
})
craftedItems.sort((a, b) => a.name.localeCompare(b.name) || a.itemId - b.itemId)

/**
 * Which equipment slots each embellishment reagent slot actually appears on,
 * measured from the recipes rather than read out of category prose. This is the
 * structural half of the embellishment restriction; the remaining prose half is
 * which reagent slot a given embellishment may go into.
 */
const embellishmentSlotSets: Record<string, string[]> = {}
for (const item of craftedItems) {
  if (item.embellishmentSlotId === null) continue
  const key = String(item.embellishmentSlotId)
  const set = (embellishmentSlotSets[key] ??= [])
  if (!set.includes(item.slot)) set.push(item.slot)
}
for (const list of Object.values(embellishmentSlotSets)) list.sort()

// --- Enchants -------------------------------------------------------------
// Names carry UI texture escapes and $-placeholders; strip them for display.
// The applicable slot does NOT derive from these tables, so it is
// classified from the name prefix and shipped unverified, for simc to confirm.
const SLOT_BY_PREFIX: Record<string, string> = {
  ring: 'finger',
  weapon: 'weapon',
  chest: 'chest',
  cloak: 'back',
  boots: 'feet',
  bracer: 'wrist',
  bracers: 'wrist',
  gloves: 'hands',
  helm: 'head',
  legs: 'legs',
  shield: 'off_hand',
  necklace: 'neck',
  neck: 'neck'
}

function cleanName(raw: string): string {
  return raw
    .replace(/\|A:.*?\|a/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Gem effect text is a template: "+$k1 Mastery & +$k2 Critical Strike". The
 * placeholders resolve against the player's level at runtime, which we do not
 * have here — so drop them and name the stats rather than inventing numbers.
 * Real values come from the stat probe, the same as item stats.
 */
function statText(raw: string): string {
  return cleanName(raw)
    .replace(/\$k\d+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Quality tiers arrive as separate rows under one name (7966 and 7967 are both
// "Enchant Ring - Eyes of the Eagle"), so collapse them into one entry whose
// ids are ordered by tier.
interface EnchantTier { id: number; tier: number; icon: string | null }
const enchantsByName = new Map<string, { name: string; slot: string | null; tiers: EnchantTier[] }>()
for (const e of enchantRows) {
  const raw = e['Name_lang'] ?? ''
  const name = cleanName(raw)
  // Stat templates ("+$k1 Intellect") have no usable label of their own.
  if (!name || name.includes('$')) continue
  const prefix = /^Enchant ([A-Za-z]+)\s*-/.exec(name)?.[1]?.toLowerCase()
  const slot = (prefix && SLOT_BY_PREFIX[prefix]) ?? null
  // The quality tier is in the texture escape the display name carries, e.g.
  // |A:Professions-ChatIcon-Quality-12-Tier2:20:20|a — stripped by cleanName().
  const tier = Number(/Professions-ChatIcon-Quality-\d+-Tier(\d)/.exec(raw)?.[1] ?? 0)
  // These rows carry no icon of their own (IconFileDataID is 0). The icon is on
  // the spell the enchant grants, named in EffectArg_0 — but that field holds a
  // stat id for other enchant kinds, so a bare lookup could attach an unrelated
  // icon. Only trust it when the spell's own name is the enchant's suffix,
  // e.g. "Enchant Ring - Eyes of the Eagle" and spell "Eyes of the Eagle".
  const granted = e['EffectArg_0']
  const grantedName = granted ? nameOfSpell.get(granted) : undefined
  const icon = iconFor(e['IconFileDataID']) ??
    (grantedName && name.endsWith(grantedName) ? iconFor(spellIcon.get(granted!)) : null)
  const entry: EnchantTier = { id: Number(e['ID']), tier, icon }
  const existing = enchantsByName.get(name)
  if (existing) existing.tiers.push(entry)
  else enchantsByName.set(name, { name, slot, tiers: [entry] })
}
const enchants = [...enchantsByName.values()]
  .map((e) => ({ ...e, tiers: e.tiers.sort((a, b) => a.tier - b.tier || a.id - b.id) }))

// --- Icon assets ----------------------------------------------------------
// Same pack, same source and same 404 tolerance as build-season-gear.ts: a
// name that is not published upstream simply falls back in the UI.
const ICON_DIR = 'src/renderer/public/item-icons'
const wanted = [...new Set([
  ...gems.flatMap((g) => g.tiers.map((t) => t.icon)),
  ...enchants.flatMap((e) => e.tiers.map((t) => t.icon)),
  ...[...embellishments.values()].map((e) => e.icon)
].filter((n): n is string => Boolean(n)))]

await mkdir(ICON_DIR, { recursive: true })
let fetched = 0
let missing = 0
const available = new Set<string>()
let nextIcon = 0
await Promise.all(Array.from({ length: 8 }, async () => {
  while (nextIcon < wanted.length) {
    const icon = wanted[nextIcon++]!
    if (!/^[a-z0-9_]+$/i.test(icon)) { missing++; continue }
    const path = `${ICON_DIR}/${icon}.jpg`
    if (await exists(path)) { available.add(icon); continue }
    const response = await fetch(`https://wow.zamimg.com/images/wow/icons/large/${icon}.jpg`)
    if (response.status === 404) { missing++; continue }
    if (!response.ok) throw new Error(`Icon ${icon}: ${response.status}`)
    await writeFile(path, Buffer.from(await response.arrayBuffer()))
    available.add(icon)
    fetched++
  }
}))
/** Never point the UI at an asset that is not on disk. */
const keep = (icon: string | null): string | null => (icon && available.has(icon) ? icon : null)

// --- Emit -----------------------------------------------------------------
const out = {
  version: 3,
  generated: new Date().toISOString(),
  build: BUILD,
  source: 'wago.tools DB2 CSV exports',
  note: 'Generated by scripts/build-db2.ts.',
  embellishedMarkerBonusId: marker,
  embellishedLimit: Number(embellishedCategory['Quantity']),
  embellishments: [...embellishments.values()]
    .map((e) => ({ ...e, icon: keep(e.icon) }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  limitCategories: Object.fromEntries(
    limitCategories.map((c) => [
      c['ID']!,
      { name: c['Name_lang']!, quantity: Number(c['Quantity']) }
    ])
  ),
  socketBonusIds,
  innateSockets,
  itemLimitCategory,
  weaponProficiency,
  shieldProficiency: shieldProficiency.sort(),
  craftedItems,
  embellishmentSlotSets,
  gems: gems
    .map((g) => ({ ...g, tiers: g.tiers.map((t) => ({ ...t, icon: keep(t.icon) })) }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  enchants: enchants
    .map((e) => ({ ...e, tiers: e.tiers.map((t) => ({ ...t, icon: keep(t.icon) })) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(`${OUT}.tmp`, JSON.stringify(out), 'utf8')
await rename(`${OUT}.tmp`, OUT)

console.log(`\nEmbellished marker bonus id: ${marker} (limit ${out.embellishedLimit}, category ${categoryId})`)
console.log(
  `Embellishments: ${out.embellishments.length} from ${trees.length} bonus trees` +
    (unnamed ? `, ${unnamed} unnamed` : ', all named')
)
{
  const withCategory = out.embellishments.filter((e) => e.categoryId !== null).length
  const current = out.embellishments.filter((e) => e.expansion === 'Midnight')
  const unknown = out.embellishments.filter((e) => e.appliesTo === 'unknown').length
  const byRule: Record<string, number> = {}
  for (const e of current) byRule[e.appliesTo] = (byRule[e.appliesTo] ?? 0) + 1
  console.log(`  crafting category resolved: ${withCategory}; current-expansion: ${current.length}; unclassified restriction: ${unknown}`)
  console.log(`  current-expansion restrictions: ${Object.entries(byRule).map(([k, n]) => `${k}=${n}`).join(', ')}`)
}
console.log(
  `Limit categories: ${Object.keys(out.limitCategories).length} names, ` +
  `${Object.keys(itemLimitCategory).length} current items belonging to one`
)
console.log(
  `Sockets: ${Object.keys(socketBonusIds).length} socket-granting bonus lists, ` +
    `${Object.keys(innateSockets).length} current items with innate sockets ` +
    `(of ${currentItems} in expansion ${CURRENT_EXPANSION})`
)
console.log(
  'Weapon proficiency: ' +
  Object.entries(weaponProficiency).map(([c, s]) => `${c}=${s.length}`).join(' ') +
  `; shields: ${shieldProficiency.join(', ')}`
)
console.log(`Gems: ${gems.length} distinct, ${gems.reduce((n, g) => n + g.tiers.length, 0)} quality tiers`)
console.log(
  `Craftable items: ${craftedItems.length} current-expansion, ` +
  `${craftedItems.filter((c) => c.embellishmentSlotId !== null).length} accepting an embellishment, ` +
  `across ${new Set(craftedItems.map((c) => c.slot)).size} slots`
)
for (const [slotId, slots] of Object.entries(embellishmentSlotSets).sort()) {
  console.log(`  embellishment reagent slot ${slotId}: ${slots.join(', ')}`)
}
console.log(`Icons: ${available.size} available (${fetched} newly downloaded, ${missing} not published upstream)`)
const withSlot = enchants.filter((e) => e.slot).length
console.log(
  `Enchants: ${enchants.length} distinct names, ${withSlot} with a slot classified from the name ` +
    `(unverified)`
)
console.log(`Wrote ${OUT}`)
