/**
 * Generates the Season 1 and Season 2 non-craftable equipment database:
 *   - src/core/data/season1-gear.json
 *   - src/core/data/season2-gear.json
 *   - src/core/data/season_gear.db (SQLite)
 *
 * Captures item details, source encounters, tier set memberships,
 * upgrade tracks, stats, and on-use/on-equip special effects.
 *
 * Run: node scripts/build-season-gear.ts
 */
import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { Generation } from './lib/generation.ts'
import { csvMap, parseCsv } from './lib/csv.ts'

const CACHE = '.cache/db2/12.1.0.69587'
/** The client build the DB2 cache above was exported for. */
const GAME_BUILD = '12.1.0.69587'

/**
 * The season this build describes, pinned by id.
 *
 * The generator used to take whichever season Raidbots currently marks active
 * and then stamp 'Midnight Season 2' on the output regardless. The day
 * Blizzard turns on the next season, a rebuild would silently apply that
 * season's upgrade bonuses to these item ids while the file still claimed to be
 * Season 2 and the manifest still reported matching game builds — wrong data
 * that validates.
 *
 * Moving to a new season is now a deliberate edit here, or an explicit
 * SEASON_ID override, rather than something that happens to whoever rebuilds
 * first.
 */
const EXPECTED_SEASON = {
  id: Number(process.env['SEASON_ID'] ?? 37),
  name: process.env['SEASON_NAME'] ?? 'Midnight Season 2'
}
const RAIDBOTS_BASE = 'https://www.raidbots.com/static/data/live/'

/** Replace a snapshot only once it is fully written. */
async function writeAtomic(path: string, contents: string): Promise<void> {
  await writeFile(`${path}.tmp`, contents, 'utf8')
  await rename(`${path}.tmp`, path)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Hashes of the upstream responses this build consumed.
 *
 * Raidbots serves a 'live' path with no version in it, so the only way to say
 * what a generated file was built from is to record what came back.
 */
const sourceRevisions: Record<string, string> = {}

async function fetchJson<T>(name: string): Promise<T> {
  const res = await fetch(`${RAIDBOTS_BASE}${name}.json`)
  if (!res.ok) throw new Error(`Raidbots ${name}: HTTP ${res.status}`)
  const text = await res.text()
  sourceRevisions[name] = 'sha256:' + createHash('sha256').update(text).digest('hex').slice(0, 12)
  return JSON.parse(text) as T
}

async function getCsv(name: string): Promise<string> {
  const path = `${CACHE}/${name}.csv`
  if (await exists(path)) {
    return await readFile(path, 'utf8')
  }
  console.log(`  Downloading ${name} from wago.tools...`)
  const res = await fetch(`https://wago.tools/db2/${name}/csv?build=12.1.0.69587`)
  if (!res.ok) throw new Error(`wago.tools ${name}: HTTP ${res.status}`)
  const text = await res.text()
  await mkdir(CACHE, { recursive: true })
  await writeFile(path, text, 'utf8')
  return text
}

const INVENTORY_SLOT_MAP: Record<number, string> = {
  1: 'head', 2: 'neck', 3: 'shoulder', 4: 'shirt', 5: 'chest', 6: 'waist', 7: 'legs',
  8: 'feet', 9: 'wrist', 10: 'hands', 11: 'finger', 12: 'trinket', 13: 'one_hand',
  14: 'shield', 15: 'ranged', 16: 'back', 17: 'two_hand', 19: 'tabard', 20: 'chest',
  21: 'main_hand', 22: 'off_hand', 23: 'holdable', 26: 'ranged'
}

const ARMOR_SUBCLASSES: Record<number, string> = {
  0: 'Generic', 1: 'Cloth', 2: 'Leather', 3: 'Mail', 4: 'Plate', 6: 'Shield'
}

const WEAPON_SUBCLASSES: Record<number, string> = {
  0: '1H Axe', 1: '2H Axe', 2: 'Bow', 3: 'Gun', 4: '1H Mace', 5: '2H Mace',
  6: 'Polearm', 7: '1H Sword', 8: '2H Sword', 9: 'Warglaive', 10: 'Staff',
  13: 'Fist Weapon', 14: 'Miscellaneous', 15: 'Dagger', 16: 'Thrown',
  18: 'Crossbow', 19: 'Wand', 20: 'Fishing Pole'
}

const STAT_NAMES: Record<number, string> = {
  3: 'Agility', 4: 'Strength', 5: 'Intellect', 6: 'Spirit', 7: 'Stamina',
  13: 'Dodge', 14: 'Parry', 32: 'Critical Strike', 36: 'Haste', 38: 'Attack Power',
  40: 'Versatility', 45: 'Spell Power', 49: 'Mastery',
  71: 'Primary Stat (Agi/Str/Int)', 72: 'Agility/Strength', 73: 'Agility/Intellect',
  74: 'Strength/Intellect'
}

const QUALITY_NAMES: Record<number, string> = {
  0: 'Poor', 1: 'Common', 2: 'Uncommon', 3: 'Rare', 4: 'Epic', 5: 'Legendary', 6: 'Artifact', 7: 'Heirloom'
}

const TRIGGER_NAMES: Record<string, string> = {
  '0': 'On-Use',
  '1': 'On-Equip',
  '2': 'Chance on Hit',
  '6': 'Soulbound'
}

/**
 * Every file this build replaces. Declared in one place so activation can
 * check the whole set before moving any of it.
 */
const OUTPUTS = [
  { target: 'src/core/data/season1-gear.json' },
  { target: 'src/core/data/season2-gear.json' },
  { target: 'src/core/data/season_gear.db' },
  { target: 'src/renderer/src/item-icons.json' },
  // Icons accumulate: a run that needs none of the existing ones must not
  // delete them.
  { target: 'src/renderer/public/item-icons', merge: true }
] as const

async function main() {
  // Nothing below writes to a live path. Outputs are built in a staging
  // directory and moved into place together at the end, so a failure anywhere
  // in between leaves the previous generation intact and usable.
  const generation = await Generation.open(OUTPUTS)
  try {
  console.log('--- Building Season 1 & Season 2 Non-Craftable Equipment Database ---')

  // 1. Load Local & DB2 tables
  console.log('Loading local metadata and DB2 tables...')
  const itemsData = JSON.parse(await readFile('src/core/data/items.json', 'utf8'))
  const db2 = JSON.parse(await readFile('src/core/data/db2.json', 'utf8'))
  const craftedIds = new Set<number>(db2.craftedItems.map((c: any) => c.itemId))

  // DB2 Spells & Effects. Every join below goes through a real CSV parser:
  // splitting on commas truncated any name containing one, and shipped
  // "Jan'thrazet" where the game says "Jan'thrazet, the Soul Fang". The
  // column lists are checked too, so a renamed export fails loudly instead of
  // quietly producing items with no effects.
  const effectDetails = new Map<string, { spellId: number; triggerType: string }>()
  for (const row of parseCsv(await getCsv('ItemEffect'), ['ID', 'SpellID', 'TriggerType'])) {
    if (!row.ID) continue
    effectDetails.set(row.ID, {
      spellId: Number(row.SpellID || 0),
      triggerType: TRIGGER_NAMES[row.TriggerType ?? '1'] || 'On-Equip'
    })
  }

  const spellNames = new Map<number, string>()
  for (const [id, name] of csvMap(await getCsv('SpellName'), 'ID', 'Name_lang')) {
    spellNames.set(Number(id), name)
  }

  const spellIconFileIds = new Map<number, string>()
  for (const row of parseCsv(await getCsv('SpellMisc'), ['SpellID', 'SpellIconFileDataID'])) {
    if (row.SpellID && row.SpellIconFileDataID && row.SpellIconFileDataID !== '0') {
      spellIconFileIds.set(Number(row.SpellID), row.SpellIconFileDataID)
    }
  }

  // Map icon file data id to name
  const iconNames = new Map<string, string>()
  for (const [id, fileName] of csvMap(await getCsv('ManifestInterfaceData'), 'ID', 'FileName')) {
    if (id && fileName) iconNames.set(id, fileName.replace(/.blp$/i, '').toLowerCase())
  }

  // Item to ItemEffect join table
  const itemToEffects = new Map<number, Array<{ spellId: number; spellName: string; trigger: string; icon: string | null }>>()
  for (const row of parseCsv(await getCsv('ItemXItemEffect'), ['ItemEffectID', 'ItemID'])) {
    const effectId = row.ItemEffectID
    const itemId = Number(row.ItemID)
    if (!itemId || !effectId) continue

    const detail = effectDetails.get(effectId)
    if (!detail || !detail.spellId) continue

    const spellName = spellNames.get(detail.spellId) || 'Unknown Spell'
    const iconFileId = spellIconFileIds.get(detail.spellId)
    const icon = iconFileId ? iconNames.get(iconFileId) ?? null : null

    const list = itemToEffects.get(itemId) ?? []
    list.push({ spellId: detail.spellId, spellName, trigger: detail.triggerType, icon })
    itemToEffects.set(itemId, list)
  }

  // 2. Load Raidbots Data
  console.log('Fetching live Raidbots game data...')
  const [equippableItems, instances, bonuses, seasons] = await Promise.all([
    fetchJson<any[]>('equippable-items'),
    fetchJson<any[]>('instances'),
    fetchJson<Record<string, any>>('bonuses'),
    fetchJson<any[]>('seasons')
  ])

  // Build instance and encounter maps
  const instanceMap = new Map<number, { name: string; type: string; encounters: Map<number, string> }>()
  for (const inst of instances) {
    const encMap = new Map<number, string>()
    if (inst.encounters) {
      for (const e of inst.encounters) {
        encMap.set(e.id, e.name)
      }
    }
    instanceMap.set(inst.id, { name: inst.name, type: inst.type, encounters: encMap })
  }

  // S1 & S2 Instance Groups
  const S1_INSTANCES = new Set([
    1307, // The Voidspire
    1314, // The Dreamrift
    1308, // March on Quel'Danas
    1305, // Sporefall — single-boss S1 raid (Rotmire); was missing from this set
    -91,  // S1 Raids
    -87,  // Catalyst S1
    -84,  // PVP S1 Honor
    -85,  // PVP S1 Conquest
    -86,  // PVP S1 Bloody Tokens
    -92,  // Delves S1
    -93   // Prey S1
  ])

  const S2_INSTANCES = new Set([
    1320, // The Venomous Abyss
    1317, // The Tidebound Grotto
    -102, // S2 Raids
    -100, // Catalyst S2
    -94,  // PVP S2 Honor
    -95,  // PVP S2 Conquest
    -96,  // PVP S2 Bloody Tokens
    -98,  // Delves S2
    -99,  // Prey S2
    -1    // M+ Dungeons S2
  ])

  // Upgrade tracks for the pinned season, not for whatever is live.
  const activeSeason = seasons.find((s: any) => s.id === EXPECTED_SEASON.id)
  if (!activeSeason) {
    throw new Error(
      'Raidbots no longer lists season ' + EXPECTED_SEASON.id + ' (' + EXPECTED_SEASON.name + '). ' +
      'Available: ' + seasons.map((s: any) => s.id + ' ' + s.name).join(', ') + '. ' +
      'Set SEASON_ID and SEASON_NAME to move deliberately.'
    )
  }
  if (activeSeason.name !== EXPECTED_SEASON.name) {
    throw new Error(
      'Season ' + EXPECTED_SEASON.id + ' is now called ' + JSON.stringify(activeSeason.name) +
      ', not ' + JSON.stringify(EXPECTED_SEASON.name) + '. Refusing to label it as the latter.'
    )
  }
  if (!activeSeason.active) {
    // Not fatal on its own — an old season's bonuses are still the right ones
    // for an old season's file — but it is never what someone rebuilding
    // casually expects, so say it out loud.
    console.warn(
      'WARNING: ' + EXPECTED_SEASON.name + ' is no longer the active season upstream. ' +
      'Building it anyway because it is pinned; set SEASON_ID to move on.'
    )
  }
  console.log('Pinned season: ' + activeSeason.name + ' (id ' + activeSeason.id + ', active=' + Boolean(activeSeason.active) + ')')
  const s2BonusGroups = new Set(activeSeason.bonusListGroups || [])
  const s2UpgradeBonuses = Object.entries(bonuses)
    .filter(([_, b]: [string, any]) => b.upgrade && s2BonusGroups.has(b.upgrade.group))
    .map(([id, b]: [string, any]) => ({
      bonusId: Number(id),
      track: b.upgrade.name,
      rank: b.upgrade.level,
      maxRank: b.upgrade.max,
      itemLevel: b.upgrade.itemLevel
    }))

  const s2TrackOrder = ['Adventurer', 'Veteran', 'Champion', 'Hero', 'Myth']

  // Process items
  console.log('Processing and enriching equipment...')
  const season1Items: any[] = []
  const season2Items: any[] = []

  for (const item of equippableItems) {
    // Filter out crafted items
    if (item.profession || craftedIds.has(item.id)) continue
    if (!item.sources || item.sources.length === 0) continue

    const inS1 = item.sources.some((s: any) => S1_INSTANCES.has(s.instanceId))
    const inS2 = item.sources.some((s: any) => S2_INSTANCES.has(s.instanceId))
    if (!inS1 && !inS2) continue

    // Classification & Slot
    const slot = INVENTORY_SLOT_MAP[item.inventoryType] || 'misc'
    let armorClass: string | undefined = undefined
    let weaponType: string | undefined = undefined

    if (item.itemClass === 4) {
      armorClass = ARMOR_SUBCLASSES[item.itemSubClass] || 'Generic'
    } else if (item.itemClass === 2) {
      weaponType = WEAPON_SUBCLASSES[item.itemSubClass] || 'Weapon'
    }

    // Tier set lookup
    const metaRow = itemsData.items[String(item.id)]
    const setId = metaRow?.[4]
    const tierSet = setId && itemsData.sets[String(setId)]
      ? { setId, setName: itemsData.sets[String(setId)].name, pieceSlot: slot }
      : undefined

    // Stats
    const stats = (item.stats || []).map((s: any) => ({
      statId: s.id,
      statName: STAT_NAMES[s.id] || `Stat ${s.id}`,
      allocation: s.alloc
    }))

    // Special effects
    const specialEffects = itemToEffects.get(item.id) || []

    // Source description
    const primarySource = item.sources[0]
    const instInfo = instanceMap.get(primarySource.instanceId)
    const sourceInfo = {
      instanceId: primarySource.instanceId,
      instanceName: instInfo?.name || `Instance ${primarySource.instanceId}`,
      instanceType: instInfo?.type || 'other',
      encounterId: primarySource.encounterId,
      encounterName: instInfo?.encounters.get(primarySource.encounterId) || (primarySource.encounterId ? `Boss ${primarySource.encounterId}` : undefined)
    }

    // Upgrade tracks
    // For S2 items from M+, Raid, Delves, or Catalyst, attach valid tracks
    let upgradeTracks: any[] = []
    if (inS2) {
      const isMplus = item.sources.some((s: any) => s.instanceId === -1)
      const isRaid = item.sources.some((s: any) => s.instanceId === -102 || s.instanceId === 1320 || s.instanceId === 1317)
      const isCatalyst = item.sources.some((s: any) => s.instanceId === -100)
      const isDelve = item.sources.some((s: any) => s.instanceId === -98 || s.instanceId === -99)

      // The catalog caps tracks by an item's *primary* source (see TRACK_CAP in
      // src/core/data/catalog.ts), because this file keeps only one source per
      // item. That is correct only while no item drops from both a Hero-capped
      // world source and a Myth-capable one — measured at zero for Season 2. If
      // a rebuild ever finds one, the primary source could hide a reachable Myth
      // variant, so stop rather than ship it.
      if (isDelve && (isMplus || isRaid || isCatalyst)) {
        throw new Error(
          item.name + ' (' + item.id + ') drops from both a Hero-capped world source and a Myth-capable one. ' +
          'Carry every source type into the catalog before capping tracks by primary source.'
        )
      }

      if (isMplus || isRaid || isCatalyst || isDelve) {
        upgradeTracks = s2UpgradeBonuses
          .slice()
          .sort((a, b) => s2TrackOrder.indexOf(a.track) - s2TrackOrder.indexOf(b.track) || a.rank - b.rank)
      }
    }

    const entry = {
      id: item.id,
      name: item.name,
      icon: item.icon,
      quality: QUALITY_NAMES[item.quality] || 'Epic',
      qualityCode: item.quality,
      slot,
      armorClass,
      weaponType,
      baseItemLevel: item.itemLevel,
      /**
       * Item-specific bonuses that are NOT upgrade-track rungs: tier/effect
       * bonuses and, most importantly, socket grants. 104 tracked items carry
       * one and every one of them is the socket bonus, so omitting this field
       * silently costs those items their socket in the gem picker.
       */
      bonusIds: (item.bonusLists ?? []) as number[],
      allowableClasses: item.allowableClasses,
      uniqueEquipped: Boolean(item.uniqueEquipped),
      tierSet,
      stats,
      specialEffects,
      source: sourceInfo,
      upgradeTracks
    }

    if (inS1) season1Items.push({ ...entry, season: 'Season 1' })
    if (inS2) season2Items.push({ ...entry, season: 'Season 2' })
  }

  season1Items.sort((a, b) => a.slot.localeCompare(b.slot) || a.name.localeCompare(b.name))
  season2Items.sort((a, b) => a.slot.localeCompare(b.slot) || a.name.localeCompare(b.name))

  console.log(`Season 1 items: ${season1Items.length}`)
  console.log(`Season 2 items: ${season2Items.length}`)

  // 3. Write JSON files
  console.log('Writing JSON exports...')
  await mkdir('src/core/data', { recursive: true })

  // Provenance travels with the data: which season id it was built from, which
  // client build the DB2 join used, and what the unversioned Raidbots responses
  // actually were.
  const provenance = {
    seasonId: EXPECTED_SEASON.id,
    sourceRevisions: { ...sourceRevisions }
  }

  const s1Output = {
    version: 1,
    generated: new Date().toISOString(),
    gameBuild: GAME_BUILD,
    season: 'Midnight Season 1',
    provenance,
    itemCount: season1Items.length,
    items: season1Items
  }
  await writeAtomic(await generation.pathFor('src/core/data/season1-gear.json'), JSON.stringify(s1Output, null, 2))
  console.log('  Wrote src/core/data/season1-gear.json')

  const s2Output = {
    version: 1,
    generated: new Date().toISOString(),
    gameBuild: GAME_BUILD,
    season: EXPECTED_SEASON.name,
    provenance,
    itemCount: season2Items.length,
    items: season2Items
  }
  await writeAtomic(await generation.pathFor('src/core/data/season2-gear.json'), JSON.stringify(s2Output, null, 2))
  console.log('  Wrote src/core/data/season2-gear.json')

  // 4. Populate SQLite database
  console.log('Creating and populating SQLite database...')
  // Staged, so the DROP statements below cannot empty the database the app is
  // currently using — but seeded from the live file, because build-spec-weapons.ts
  // writes spec_weapon_rules and spec_weapon_combinations into this same
  // database. Starting from an empty file silently dropped that other
  // generator's tables; the test for them is what caught it.
  const dbPath = await generation.seed('src/core/data/season_gear.db')
  const db = new DatabaseSync(dbPath)

  db.exec(`
    DROP TABLE IF EXISTS effects;
    DROP TABLE IF EXISTS upgrade_tracks;
    DROP TABLE IF EXISTS stats;
    DROP TABLE IF EXISTS sources;
    DROP TABLE IF EXISTS items;

    CREATE TABLE items (
      id INTEGER,
      season TEXT NOT NULL,
      name TEXT NOT NULL,
      icon TEXT,
      quality TEXT NOT NULL,
      slot TEXT NOT NULL,
      armor_class TEXT,
      weapon_type TEXT,
      base_ilvl INTEGER,
      set_id INTEGER,
      set_name TEXT,
      unique_equipped INTEGER,
      has_special_effect INTEGER,
      raw_json TEXT,
      PRIMARY KEY (id, season)
    );

    CREATE TABLE sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      season TEXT NOT NULL,
      instance_id INTEGER NOT NULL,
      instance_name TEXT NOT NULL,
      instance_type TEXT NOT NULL,
      encounter_id INTEGER,
      encounter_name TEXT
    );

    CREATE TABLE stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      season TEXT NOT NULL,
      stat_id INTEGER NOT NULL,
      stat_name TEXT NOT NULL,
      allocation INTEGER NOT NULL
    );

    CREATE TABLE upgrade_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      season TEXT NOT NULL,
      track TEXT NOT NULL,
      rank INTEGER NOT NULL,
      max_rank INTEGER NOT NULL,
      ilvl INTEGER NOT NULL,
      bonus_id INTEGER NOT NULL
    );

    CREATE TABLE effects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      season TEXT NOT NULL,
      spell_id INTEGER NOT NULL,
      spell_name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      icon TEXT
    );

    CREATE INDEX idx_items_season ON items (season);
    CREATE INDEX idx_items_slot ON items (slot);
    CREATE INDEX idx_items_armor_class ON items (armor_class);
    CREATE INDEX idx_items_set_id ON items (set_id);
    CREATE INDEX idx_items_effects ON items (has_special_effect);
    CREATE INDEX idx_sources_item ON sources (item_id, season);
    CREATE INDEX idx_stats_item ON stats (item_id, season);
    CREATE INDEX idx_upgrade_tracks_item ON upgrade_tracks (item_id, season);
    CREATE INDEX idx_effects_item ON effects (item_id, season);
  `)

  const insertItem = db.prepare(`
    INSERT INTO items (
      id, season, name, icon, quality, slot, armor_class, weapon_type,
      base_ilvl, set_id, set_name, unique_equipped, has_special_effect, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertSource = db.prepare(`
    INSERT INTO sources (item_id, season, instance_id, instance_name, instance_type, encounter_id, encounter_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const insertStat = db.prepare(`
    INSERT INTO stats (item_id, season, stat_id, stat_name, allocation)
    VALUES (?, ?, ?, ?, ?)
  `)

  const insertTrack = db.prepare(`
    INSERT INTO upgrade_tracks (item_id, season, track, rank, max_rank, ilvl, bonus_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const insertEffect = db.prepare(`
    INSERT INTO effects (item_id, season, spell_id, spell_name, trigger_type, icon)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const allEntries = [...season1Items, ...season2Items]

  db.exec('BEGIN TRANSACTION')
  for (const item of allEntries) {
    insertItem.run(
      item.id,
      item.season,
      item.name,
      item.icon || null,
      item.quality,
      item.slot,
      item.armorClass || null,
      item.weaponType || null,
      item.baseItemLevel || null,
      item.tierSet?.setId || null,
      item.tierSet?.setName || null,
      item.uniqueEquipped ? 1 : 0,
      item.specialEffects.length > 0 ? 1 : 0,
      JSON.stringify(item)
    )

    insertSource.run(
      item.id,
      item.season,
      item.source.instanceId,
      item.source.instanceName,
      item.source.instanceType,
      item.source.encounterId || null,
      item.source.encounterName || null
    )

    for (const s of item.stats) {
      insertStat.run(item.id, item.season, s.statId, s.statName, s.allocation)
    }

    for (const t of item.upgradeTracks) {
      insertTrack.run(item.id, item.season, t.track, t.rank, t.maxRank, t.itemLevel, t.bonusId)
    }

    for (const e of item.specialEffects) {
      insertEffect.run(item.id, item.season, e.spellId, e.spellName, e.trigger, e.icon || null)
    }
  }
  db.exec('COMMIT')
  db.close()

  console.log(`  Wrote ${dbPath} with ${allEntries.length} item records`)

  // 5. Download missing icon assets and update item-icons.json
  console.log('Synchronizing icon assets...')
  const ICON_DIR = await generation.seed('src/renderer/public/item-icons')
  await mkdir(ICON_DIR, { recursive: true })
  const existingFiles = new Set((await readFile(ICON_DIR).catch(() => [])) ? (await import('node:fs')).readdirSync(ICON_DIR).map((f) => f.replace(/\.jpg$/i, '')) : [])
  /**
   * Also cover the reference export's own gear. 47 of fixture #1's 102 items are
   * outside the season inventory — old-content and PvP pieces the player still
   * wears — and build-item-catalog.ts used to supply their icons. Without this
   * they would fall back to the neutral mark on a from-scratch icon rebuild.
   */
  const fixtureIds = new Set(
    [...(await readFile('fixtures/vahshandooz-elemental.simc', 'utf8').catch(() => '')).matchAll(/,id=([0-9]+)/g)]
      .map((m) => Number(m[1]))
  )
  const referenceIcons = equippableItems
    .filter((i: any) => fixtureIds.has(i.id) && i.icon)
    .map((i: any) => ({ id: i.id, icon: i.icon as string }))

  const wantedIcons = [...new Set([...allEntries, ...referenceIcons].map((i) => i.icon).filter(Boolean))]
  const missingIcons = wantedIcons.filter((icon) => !existingFiles.has(icon))

  if (missingIcons.length) {
    console.log(`  Downloading ${missingIcons.length} missing icon assets...`)
    let nextIcon = 0
    let downloaded = 0
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (nextIcon < missingIcons.length) {
          const icon = missingIcons[nextIcon++]!
          if (!/^[a-z0-9_]+$/i.test(icon)) continue
          const iconPath = `${ICON_DIR}/${icon}.jpg`
          try {
            const res = await fetch(`https://wow.zamimg.com/images/wow/icons/large/${icon}.jpg`)
            if (res.status === 404 || !res.ok) continue
            const buf = Buffer.from(await res.arrayBuffer())
            await writeFile(iconPath, buf)
            downloaded++
          } catch {
            // Offline/timeout fallback tolerated
          }
        }
      })
    )
    console.log(`  Downloaded ${downloaded} new icons`)
  }

  // Update item-icons.json
  const currentIconMap = JSON.parse(await readFile('src/renderer/src/item-icons.json', 'utf8').catch(() => '{}'))
  const availableIcons = new Set((await import('node:fs')).readdirSync(ICON_DIR).map((f) => f.replace(/\.jpg$/i, '')))
  let newMappings = 0
  for (const item of [...allEntries, ...referenceIcons]) {
    if (item.icon && availableIcons.has(item.icon) && !currentIconMap[item.id]) {
      currentIconMap[item.id] = item.icon
      newMappings++
    }
  }
  // Written every run, not only when mappings changed: activation requires
  // every declared output to exist, and 'unchanged' is still a value.
  await writeFile(await generation.pathFor('src/renderer/src/item-icons.json'), JSON.stringify(currentIconMap), 'utf8')
  if (newMappings) {
    console.log(`  Added ${newMappings} new item-to-icon mappings to item-icons.json (Total: ${Object.keys(currentIconMap).length})`)
  }

  // Everything is built and nothing live has been touched. Activation checks
  // the whole set exists, keeps the generation it replaces, and only then
  // moves the new one into place.
  await generation.activate()
  console.log('Activated the new generation; the previous one is kept in .generation/previous')

  console.log('--- Done ---')
  } catch (error) {
    await generation.discard()
    console.error('Nothing was replaced — the previous generation is still active.')
    throw error
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
