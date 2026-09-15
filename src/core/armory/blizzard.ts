/**
 * Importing a character from the Blizzard armory instead of the SimC addon.
 *
 * The Blizzard profile API returns the same identifiers the addon exports —
 * item ids, bonus ids in the same order, enchant ids, gem item ids, crafted
 * stats — so the character is written out as an addon-format string and goes
 * through exactly the same parser, simulation and history as a pasted export.
 *
 * What the API cannot give: bag contents and loadout names. An armory profile
 * therefore carries only equipped gear, and its talent loadouts are numbered.
 * The data is also only as fresh as the character's last logout.
 */
import { createHash } from 'node:crypto'
import { statDonor } from '../data/catalog.ts'

export const ARMORY_REGIONS = ['us', 'eu', 'kr', 'tw'] as const
export type ArmoryRegion = (typeof ARMORY_REGIONS)[number]

export interface ArmoryCredentials { clientId: string; clientSecret: string }

/** The three profile endpoints the conversion reads, as Blizzard returns them. */
export interface ArmoryData {
  summary: {
    name: string
    level: number
    race: { id: number; name: string }
    character_class: { id: number; name: string }
    active_spec?: { id: number; name: string }
    realm: { name: string; slug: string }
    last_login_timestamp?: number
  }
  equipment: {
    equipped_items: Array<{
      slot: { type: string }
      item: { id: number }
      name: string
      level?: { value: number }
      bonus_list?: number[]
      enchantments?: Array<{ enchantment_id?: number; enchantment_slot?: { type: string } }>
      sockets?: Array<{ item?: { id: number } }>
      modified_crafting_stat?: Array<{ id: number }>
      stats?: Array<{ type: { type: string }; value: number; is_negated?: boolean }>
    }>
  }
  specializations: {
    active_specialization?: { id: number }
    specializations?: Array<{
      specialization: { id: number }
      loadouts?: Array<{ is_active: boolean; talent_loadout_code?: string }>
    }>
  }
}

/** simc class keys by Blizzard playable-class id. */
const CLASS_KEYS: Record<number, string> = {
  1: 'warrior', 2: 'paladin', 3: 'hunter', 4: 'rogue', 5: 'priest', 6: 'deathknight', 7: 'shaman',
  8: 'mage', 9: 'warlock', 10: 'monk', 11: 'druid', 12: 'demonhunter', 13: 'evoker'
}

/** Addon slot names by Blizzard slot type, in the order the addon writes them. */
const SLOTS: ReadonlyArray<[string, string]> = [
  ['HEAD', 'head'], ['NECK', 'neck'], ['SHOULDER', 'shoulder'], ['BACK', 'back'], ['CHEST', 'chest'],
  ['WRIST', 'wrist'], ['HANDS', 'hands'], ['WAIST', 'waist'], ['LEGS', 'legs'], ['FEET', 'feet'],
  ['FINGER_1', 'finger1'], ['FINGER_2', 'finger2'], ['TRINKET_1', 'trinket1'], ['TRINKET_2', 'trinket2'],
  ['MAIN_HAND', 'main_hand'], ['OFF_HAND', 'off_hand']
]

/** simc stat ids for the secondary ratings Blizzard names. */
const RATING_STATS: Record<string, number> = {
  CRIT_RATING: 32, HASTE_RATING: 36, VERSATILITY: 40, MASTERY_RATING: 49
}

/** "Kul Tiran" → "kul_tiran", "Mag'har Orc" → "maghar_orc": simc's token style. */
export function simcToken(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** Realm names as typed ("Argent Dawn", "Kel'Thuzad") to the slug the API wants. */
export function realmSlug(realm: string): string {
  return realm.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function formatDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
    pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/** Writes armory data as an addon-format profile string. */
export function armoryToSimc(data: ArmoryData, region: ArmoryRegion): string {
  const { summary } = data
  const classKey = CLASS_KEYS[summary.character_class.id]
  if (!classKey) throw new Error('Unsupported class: ' + summary.character_class.name)
  const specName = summary.active_spec?.name ?? ''
  const exported = summary.last_login_timestamp ? new Date(summary.last_login_timestamp) : new Date()

  const lines: string[] = [
    '# ' + [summary.name, specName, formatDate(exported), region.toUpperCase() + '/' + summary.realm.name].join(' - '),
    '# Imported from the Blizzard armory: equipped gear as of the last logout, no bag items.',
    '',
    classKey + '="' + summary.name + '"',
    'level=' + summary.level,
    'race=' + simcToken(summary.race.name),
    'region=' + region,
    'server=' + summary.realm.slug,
    ''
  ]
  if (specName) lines.push('spec=' + simcToken(specName), '')

  const activeSpecId = data.specializations.active_specialization?.id ?? summary.active_spec?.id
  const loadouts = data.specializations.specializations
    ?.find((s) => s.specialization.id === activeSpecId)?.loadouts ?? []
  const active = loadouts.find((l) => l.is_active)?.talent_loadout_code
  if (active) lines.push('talents=' + active, '')
  // The API has no loadout names; number the other saved loadouts so the
  // Loadouts comparison still has something to compare.
  const others = [...new Set(loadouts.map((l) => l.talent_loadout_code).filter((c): c is string => !!c && c !== active))]
  others.forEach((code, index) => lines.push('# Saved Loadout: Armory loadout ' + (index + 1), '# talents=' + code))
  if (others.length > 0) lines.push('')

  const bySlot = new Map(data.equipment.equipped_items.map((item) => [item.slot.type, item]))
  for (const [blizzardSlot, slot] of SLOTS) {
    const item = bySlot.get(blizzardSlot)
    if (!item) continue
    const parts = ['id=' + item.item.id]
    const enchant = item.enchantments?.find((e) => e.enchantment_slot?.type === 'PERMANENT' && e.enchantment_id)
    if (enchant) parts.push('enchant_id=' + enchant.enchantment_id)
    const gems = (item.sockets ?? []).map((s) => s.item?.id ?? 0)
    if (gems.some((g) => g > 0)) parts.push('gem_id=' + gems.join('/'))
    if (item.bonus_list?.length) parts.push('bonus_id=' + item.bonus_list.join('/'))
    if (item.modified_crafting_stat?.length) parts.push('crafted_stats=' + item.modified_crafting_stat.map((s) => s.id).join('/'))
    // Pieces made by the catalyst keep the original item's stat split, which
    // shows in the ratings Blizzard reports even when the item is not in a set.
    const observed = (item.stats ?? [])
      .filter((s) => !s.is_negated && RATING_STATS[s.type.type])
      .map((s) => ({ statId: RATING_STATS[s.type.type]!, amount: s.value }))
    const donor = statDonor(item.item.id, slot, observed)
    if (donor) parts.push('redirected_base_stats=' + donor)
    lines.push('# ' + item.name + ' (' + (item.level?.value ?? 0) + ')', slot + '=,' + parts.join(','))
  }

  const body = lines.join('\n') + '\n'
  // History keys saved profiles by checksum, as the addon's export provides.
  const checksum = createHash('sha256').update(body).digest('hex').slice(0, 8)
  return body + '\n# Checksum: ' + checksum + '\n'
}

/** Failures worth showing the user as they are. */
export class ArmoryError extends Error {}

interface Token { value: string; expires: number }
const tokens = new Map<string, Token>()

async function accessToken(region: ArmoryRegion, credentials: ArmoryCredentials, doFetch: typeof fetch, signal?: AbortSignal): Promise<string> {
  const key = region + ':' + credentials.clientId
  const cached = tokens.get(key)
  if (cached && cached.expires > Date.now() + 60_000) return cached.value
  const response = await doFetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(credentials.clientId + ':' + credentials.clientSecret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials',
    signal
  })
  if (response.status === 401 || response.status === 400) throw new ArmoryError('Blizzard rejected the API client ID or secret.')
  if (!response.ok) throw new ArmoryError('Blizzard sign-in failed (HTTP ' + response.status + ').')
  const body = await response.json() as { access_token: string; expires_in: number }
  tokens.set(key, { value: body.access_token, expires: Date.now() + body.expires_in * 1000 })
  return body.access_token
}

async function getJson<T>(url: string, token: string, doFetch: typeof fetch, signal?: AbortSignal): Promise<T> {
  const response = await doFetch(url, { headers: { Authorization: 'Bearer ' + token }, signal })
  if (response.status === 404) {
    throw new ArmoryError('Character not found. Check the region, realm and name; Blizzard only lists characters that have logged in recently.')
  }
  if (response.status === 403) throw new ArmoryError('Blizzard would not share this character (HTTP 403).')
  if (response.status === 429) throw new ArmoryError('Blizzard is rate limiting requests; try again in a minute.')
  if (!response.ok) throw new ArmoryError('Blizzard answered HTTP ' + response.status + '.')
  return await response.json() as T
}

export interface ArmoryLookup {
  region: ArmoryRegion
  realm: string
  name: string
  credentials: ArmoryCredentials
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/** Fetches a character and returns it as an addon-format profile string. */
export async function fetchArmoryProfile(lookup: ArmoryLookup): Promise<{ raw: string; lastLogin: number | null }> {
  if (!ARMORY_REGIONS.includes(lookup.region)) throw new ArmoryError('Unknown region: ' + lookup.region)
  const realm = realmSlug(lookup.realm)
  const name = lookup.name.trim().toLowerCase()
  if (!realm || !name) throw new ArmoryError('Enter a realm and a character name.')
  const doFetch = lookup.fetchImpl ?? fetch
  const token = await accessToken(lookup.region, lookup.credentials, doFetch, lookup.signal)
  const base = 'https://' + lookup.region + '.api.blizzard.com/profile/wow/character/' +
    encodeURIComponent(realm) + '/' + encodeURIComponent(name)
  const query = '?namespace=profile-' + lookup.region + '&locale=en_US'
  const [summary, equipment, specializations] = await Promise.all([
    getJson<ArmoryData['summary']>(base + query, token, doFetch, lookup.signal),
    getJson<ArmoryData['equipment']>(base + '/equipment' + query, token, doFetch, lookup.signal),
    getJson<ArmoryData['specializations']>(base + '/specializations' + query, token, doFetch, lookup.signal)
  ])
  return {
    raw: armoryToSimc({ summary, equipment, specializations }, lookup.region),
    lastLogin: summary.last_login_timestamp ?? null
  }
}

/** Where Blizzard serves character renders; nothing else is downloaded as a portrait. */
const RENDER_HOST = 'render.worldofwarcraft.com'
const MAX_PORTRAIT_BYTES = 512 * 1024

/**
 * The character's avatar as a data URL, or null when Blizzard has none (a
 * character not seen recently, or one on a realm the API does not list).
 */
export async function fetchCharacterPortrait(lookup: ArmoryLookup): Promise<string | null> {
  if (!ARMORY_REGIONS.includes(lookup.region)) return null
  const realm = realmSlug(lookup.realm)
  const name = lookup.name.trim().toLowerCase()
  if (!realm || !name) return null
  const doFetch = lookup.fetchImpl ?? fetch
  const token = await accessToken(lookup.region, lookup.credentials, doFetch, lookup.signal)
  const response = await doFetch('https://' + lookup.region + '.api.blizzard.com/profile/wow/character/' +
    encodeURIComponent(realm) + '/' + encodeURIComponent(name) + '/character-media?namespace=profile-' + lookup.region,
  { headers: { Authorization: 'Bearer ' + token }, signal: lookup.signal })
  if (!response.ok) return null
  const media = await response.json() as { assets?: Array<{ key: string; value: string }> }
  const avatar = media.assets?.find((a) => a.key === 'avatar')?.value
  if (!avatar) return null
  const url = new URL(avatar)
  if (url.protocol !== 'https:' || url.hostname !== RENDER_HOST) return null
  const image = await doFetch(url, { signal: lookup.signal })
  const type = image.headers.get('content-type') ?? ''
  if (!image.ok || !/^image\/(jpeg|png|webp)$/.test(type)) return null
  const bytes = Buffer.from(await image.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_PORTRAIT_BYTES) return null
  return 'data:' + type + ';base64,' + bytes.toString('base64')
}

/** Realm names for the region, for suggestions while typing. */
export async function fetchRealms(region: ArmoryRegion, credentials: ArmoryCredentials, fetchImpl?: typeof fetch): Promise<Array<{ name: string; slug: string }>> {
  const doFetch = fetchImpl ?? fetch
  const token = await accessToken(region, credentials, doFetch)
  const body = await getJson<{ realms: Array<{ name: string; slug: string }> }>(
    'https://' + region + '.api.blizzard.com/data/wow/realm/index?namespace=dynamic-' + region + '&locale=en_US', token, doFetch)
  return body.realms.map((r) => ({ name: r.name, slug: r.slug })).sort((a, b) => a.name.localeCompare(b.name))
}
