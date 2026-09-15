/**
 * Parser for SimC addon export strings.
 *
 * CRITICAL: comments carry data. A naive "strip # lines" parser silently
 * discards the entire Top Gear candidate pool and every saved talent loadout
 * while still producing a valid-looking profile. This is a section state
 * machine, not a regex sweep.
 */
import {
  type CandidateItem,
  type ItemString,
  type ItemToken,
  type Profile,
  type ProfileHeader,
  type SavedLoadout,
  toSlotClass
} from '../types.ts'

/** simc class keys — the `<class>="Name"` line is how the class is declared. */
const CLASS_KEYS = new Set([
  'deathknight', 'demonhunter', 'druid', 'evoker', 'hunter', 'mage', 'monk',
  'paladin', 'priest', 'rogue', 'shaman', 'warlock', 'warrior'
])

/** Profile-level scalars we interpret directly. Everything else is preserved verbatim. */
const KNOWN_PROFILE_KEYS = new Set([
  'level', 'race', 'region', 'server', 'role', 'spec', 'talents'
])

type Section = 'head' | 'bags' | 'additional'

const RE_ITEM_LINE = /^([a-z_][a-z0-9_]*)=,(.*)$/i
const RE_NAME_ILVL = /^(.*?)\s+\((\d+)\)\s*$/
const RE_KV = /^([a-z_][a-z0-9_]*)=(.*)$/i

/** Splits an item body into ordered tokens, preserving unknown keys verbatim. */
function parseTokens(body: string): ItemToken[] {
  const tokens: ItemToken[] = []
  for (const part of body.split(',')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    if (eq === -1) tokens.push({ key: part, value: '' })
    else tokens.push({ key: part.slice(0, eq), value: part.slice(eq + 1) })
  }
  return tokens
}

function numList(v: string | undefined): number[] {
  if (!v) return []
  return v.split('/').map((n) => Number(n)).filter((n) => Number.isFinite(n))
}

function buildItemString(emittedSlot: string, body: string): ItemString {
  const tokens = parseTokens(body)
  const get = (k: string): string | undefined => tokens.find((t) => t.key === k)?.value
  const enchant = get('enchant_id')
  const ilevel = get('ilevel')
  return {
    emittedSlot,
    tokens,
    id: Number(get('id') ?? NaN),
    bonusIds: numList(get('bonus_id')),
    gemIds: numList(get('gem_id')),
    enchantId: enchant ? Number(enchant) : undefined,
    ilvlOverride: ilevel ? Number(ilevel) : undefined
  }
}

/** Re-emits an item string. Round-trips verbatim, including unknown tokens. */
export function emitItemString(item: ItemString, slotOverride?: string): string {
  const body = item.tokens
    .map((t) => (t.value === '' ? t.key : `${t.key}=${t.value}`))
    .join(',')
  return `${slotOverride ?? item.emittedSlot}=,${body}`
}

export function parseAddonProfile(raw: string): Profile {
  const lines = raw.split(/\r?\n/)
  const header: ProfileHeader = {}
  const warnings: string[] = []
  const savedLoadouts: SavedLoadout[] = []
  const extraProfileLines: ItemToken[] = []
  const equipped: CandidateItem[] = []
  const bagItems: CandidateItem[] = []
  const additionalInfo: Record<string, string> = {}

  let section: Section = 'head'
  let className = ''
  let characterName = ''
  let level: number | undefined
  let race: string | undefined
  let role: string | undefined
  let spec: string | undefined
  let talents: string | undefined
  let checksum: string | undefined

  /** The most recent `# Name (ilvl)` comment, consumed by the next item line. */
  let pendingName: { name: string; ilvl: number } | null = null
  /** Set by `# Saved Loadout: <name>`, consumed by the next `# talents=` line. */
  let pendingLoadout: string | null = null

  const pushItem = (emittedSlot: string, body: string, source: 'equipped' | 'bags'): void => {
    const slotClass = toSlotClass(emittedSlot)
    const meta = pendingName
    pendingName = null
    if (slotClass === null) return // cosmetic slot (tabard/shirt) — skip silently
    const item = buildItemString(emittedSlot, body)
    if (!Number.isFinite(item.id)) {
      warnings.push(`Item in slot "${emittedSlot}" has no valid id; skipped.`)
      return
    }
    if (!meta) {
      warnings.push(`Item id=${item.id} (${emittedSlot}) had no preceding name comment.`)
    }
    const candidate: CandidateItem = {
      item,
      name: meta?.name ?? `item:${item.id}`,
      ilvl: meta?.ilvl ?? item.ilvlOverride ?? 0,
      slotClass,
      source
    }
    if (source === 'equipped') equipped.push(candidate)
    else bagItems.push(candidate)
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') continue

    // --- Section markers ---------------------------------------------------
    if (line.startsWith('###')) {
      const marker = line.replace(/^#+\s*/, '').toLowerCase()
      if (marker.startsWith('gear from bags')) section = 'bags'
      else if (marker.startsWith('additional character info')) section = 'additional'
      continue
    }

    // --- Comment lines: may be payload, may be decoration -----------
    if (line.startsWith('#')) {
      const c = line.replace(/^#+\s?/, '').trim()
      if (c === '') continue

      const loadout = c.match(/^Saved Loadout:\s*(.+)$/i)
      if (loadout) {
        pendingLoadout = loadout[1].trim()
        continue
      }

      const sum = c.match(/^Checksum:\s*([0-9a-f]+)$/i)
      if (sum) {
        checksum = sum[1]
        continue
      }

      const req = c.match(/^Requires SimulationCraft\s+([0-9]+-[0-9]+)/i)
      if (req) {
        header.requiresSimcBuild = req[1]
        continue
      }

      const addon = c.match(/^SimC Addon\s+(.+)$/i)
      if (addon) {
        header.addonVersion = addon[1].trim()
        continue
      }

      const wow = c.match(/^WoW\s+([0-9.]+),\s*TOC\s*(\d+)/i)
      if (wow) {
        header.wowBuild = wow[1]
        header.tocVersion = wow[2]
        continue
      }

      // A commented item line: a bag candidate.
      const commentedItem = c.match(RE_ITEM_LINE)
      if (commentedItem) {
        pushItem(commentedItem[1], commentedItem[2], 'bags')
        continue
      }

      const kv = c.match(RE_KV)
      if (kv) {
        const key = kv[1]
        const value = kv[2]
        if (key === 'talents' && pendingLoadout !== null) {
          savedLoadouts.push({ name: pendingLoadout, talents: value })
          pendingLoadout = null
          continue
        }
        if (section === 'additional') {
          additionalInfo[key] = value
          continue
        }
        continue // a genuinely disabled option, e.g. `# loot_spec=`
      }

      // `# Name (ilvl)` — metadata consumed by the next item line.
      const named = c.match(RE_NAME_ILVL)
      if (named) {
        pendingName = { name: named[1].trim(), ilvl: Number(named[2]) }
        continue
      }

      // Free-text header, e.g. "Vahshandooz - Elemental - <date> - EU/Draenor"
      if (!header.characterName) {
        const h = c.split(' - ').map((x) => x.trim())
        if (h.length >= 4) {
          header.characterName = h[0]
          header.specLabel = h[1]
          header.exportedAt = h[2]
          const loc = h[3].split('/')
          header.region = loc[0]
          header.realm = loc.slice(1).join('/')
        }
      }
      continue
    }

    // --- Live (uncommented) lines -----------------------------------------
    const liveItem = line.match(RE_ITEM_LINE)
    if (liveItem) {
      pushItem(liveItem[1], liveItem[2], 'equipped')
      continue
    }

    const kv = line.match(RE_KV)
    if (!kv) {
      warnings.push(`Unrecognised line: ${line.slice(0, 80)}`)
      continue
    }
    const key = kv[1]
    const valueRaw = kv[2]
    const value = valueRaw.replace(/^"(.*)"$/, '$1')

    if (CLASS_KEYS.has(key)) {
      className = key
      characterName = value
      continue
    }
    if (!KNOWN_PROFILE_KEYS.has(key)) {
      // Unknown profile-level line (e.g. omnium_talents). Preserved verbatim.
      extraProfileLines.push({ key, value: valueRaw })
      continue
    }

    switch (key) {
      case 'level': level = Number(value); break
      case 'race': race = value; break
      case 'role': role = value; break
      case 'spec': spec = value; break
      case 'talents': talents = value; break
      case 'region': header.region ??= value; break
      case 'server': header.realm ??= value; break
    }
  }

  if (!className) warnings.push('No class line found; profile is not simmable.')

  return {
    raw,
    checksum,
    header,
    className,
    characterName,
    level,
    race,
    role,
    spec,
    talents,
    savedLoadouts,
    extraProfileLines,
    equipped,
    bagItems,
    additionalInfo,
    warnings
  }
}
