import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { armoryToSimc, fetchArmoryProfile, realmSlug, simcToken, type ArmoryData } from '../src/core/armory/blizzard.ts'
import { statDonor } from '../src/core/data/catalog.ts'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'

/**
 * Armory import. The fixture is the Blizzard API's answer for the same
 * character as fixtures/vahshandooz-elemental.simc, trimmed to the fields the
 * converter reads, so the two can be held against each other.
 */

const data = JSON.parse(readFileSync('fixtures/vahshandooz-armory.json', 'utf8')) as ArmoryData
const addon = parseAddonProfile(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))

/** An item line without the tokens only the addon can know. */
function comparable(line: string): string {
  return line.split(',').filter((t) => !/^(content_tuning|crafting_quality|drop_level)=/.test(t)).join(',')
}

test('equipped gear converts to the lines the addon exports for the same character', () => {
  const armory = parseAddonProfile(armoryToSimc(data, 'eu'))
  assert.deepEqual(armory.warnings, [])
  const lines = (p: typeof armory) => p.equipped.map((c) => comparable(c.item.emittedSlot + '=,' + c.item.tokens.map((t) => t.key + '=' + t.value).join(',')))
  // Includes the catalyst pieces: the donor item behind each is recovered from
  // Blizzard's reported ratings, and it is the same one the addon names.
  assert.deepEqual(lines(armory), lines(addon))
  assert.deepEqual(armory.equipped.map((c) => [c.name, c.ilvl]), addon.equipped.map((c) => [c.name, c.ilvl]))
})

test('the profile header carries what the app shows and History keys on', () => {
  const raw = armoryToSimc(data, 'eu')
  const profile = parseAddonProfile(raw)
  assert.equal(profile.className, 'shaman')
  assert.equal(profile.characterName, 'Vahshandooz')
  assert.equal(profile.spec, 'elemental')
  assert.equal(profile.level, 90)
  assert.equal(profile.header.region, 'EU')
  assert.equal(profile.header.realm, 'Draenor')
  assert.match(profile.checksum ?? '', /^[0-9a-f]{8}$/)
  assert.equal(profile.bagItems.length, 0)
  // Same input, same checksum: History must not see a re-import as a new profile.
  assert.equal(parseAddonProfile(armoryToSimc(data, 'eu')).checksum, profile.checksum)
})

test('the active loadout is the talents; the other saved loadouts are kept, numbered', () => {
  const profile = parseAddonProfile(armoryToSimc(data, 'eu'))
  const loadouts = data.specializations.specializations!.find((s) => s.specialization.id === 262)!.loadouts!
  assert.equal(profile.talents, loadouts.find((l) => l.is_active)!.talent_loadout_code)
  assert.ok(profile.savedLoadouts.length > 0)
  assert.ok(profile.savedLoadouts.every((l) => l.talents !== profile.talents), 'the active loadout was repeated')
  assert.equal(new Set(profile.savedLoadouts.map((l) => l.talents)).size, profile.savedLoadouts.length)
  assert.equal(profile.savedLoadouts[0]!.name, 'Armory loadout 1')
})

test('names become simc tokens and realm slugs', () => {
  assert.equal(simcToken("Mag'har Orc"), 'maghar_orc')
  assert.equal(simcToken('Kul Tiran'), 'kul_tiran')
  assert.equal(simcToken('Beast Mastery'), 'beast_mastery')
  assert.equal(realmSlug("Kel'Thuzad"), 'kelthuzad')
  assert.equal(realmSlug('  Argent Dawn '), 'argent-dawn')
  assert.equal(realmSlug('Aggra (Português)'), 'aggra-portugues')
})

test('an item that was not converted gets no donor, and neither does an unknown one', () => {
  // Lightspire Core is not a season armour piece; a plain item keeps its own stats.
  assert.equal(statDonor(250214, 'trinket1', [{ statId: 32, amount: 50 }, { statId: 36, amount: 50 }]), undefined)
  assert.equal(statDonor(1, 'head', [{ statId: 32, amount: 75 }, { statId: 49, amount: 116 }]), undefined)
  // The tier helm at its own split (haste-heavy) is left alone...
  assert.equal(statDonor(271483, 'head', [{ statId: 36, amount: 133 }, { statId: 32, amount: 58 }]), undefined)
  // ...and at the Sethraliss split it is recognised as converted.
  assert.equal(statDonor(271483, 'head', [{ statId: 32, amount: 75 }, { statId: 49, amount: 116 }]), 239035)
})

/** A stand-in for Blizzard: token, then the three profile endpoints. */
function blizzard(status: Record<string, number> = {}): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    const url = String(input)
    urls.push(url)
    const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code })
    if (url.startsWith('https://oauth.battle.net/token')) return json({ access_token: 'token', expires_in: 3600 }, status['token'] ?? 200)
    if (url.includes('/equipment')) return json(data.equipment, status['character'] ?? 200)
    if (url.includes('/specializations')) return json(data.specializations, status['character'] ?? 200)
    return json(data.summary, status['character'] ?? 200)
  }) as typeof fetch
  return { fetch: impl, urls }
}

test('a lookup asks the right region and realm, and returns the converted profile', async () => {
  const stub = blizzard()
  const result = await fetchArmoryProfile({
    region: 'eu', realm: 'Draenor', name: 'Vahshandooz',
    credentials: { clientId: 'test-a', clientSecret: 's' }, fetchImpl: stub.fetch
  })
  assert.equal(result.raw, armoryToSimc(data, 'eu'))
  assert.ok(stub.urls.some((u) => u.startsWith('https://eu.api.blizzard.com/profile/wow/character/draenor/vahshandooz/equipment?namespace=profile-eu')))
})

test('lookups fail with messages a player can act on', async () => {
  const lookup = { region: 'eu' as const, realm: 'Draenor', name: 'Nobody' }
  await assert.rejects(
    () => fetchArmoryProfile({ ...lookup, credentials: { clientId: 'test-b', clientSecret: 's' }, fetchImpl: blizzard({ character: 404 }).fetch }),
    /Character not found/
  )
  await assert.rejects(
    () => fetchArmoryProfile({ ...lookup, credentials: { clientId: 'test-c', clientSecret: 's' }, fetchImpl: blizzard({ token: 401 }).fetch }),
    /rejected the API client/
  )
  await assert.rejects(
    () => fetchArmoryProfile({ ...lookup, realm: ' ', credentials: { clientId: 'test-d', clientSecret: 's' }, fetchImpl: blizzard().fetch }),
    /Enter a realm/
  )
})
