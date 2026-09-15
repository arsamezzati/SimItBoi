import { useEffect, useState } from 'react'

import type { SimItBoiApi } from '../../core/api.ts'
import type { CatalogResult } from '../../core/data/catalog.ts'
import type { Enchant, Gem, QualityTier } from '../../core/data/db2.ts'
import type { HypotheticalInput } from '../../core/topgear/hypothetical.ts'
import ItemIcon from './ItemIcon.tsx'
const api = (window as unknown as { simitboi: SimItBoiApi }).simitboi

/**
 * Everything the user chooses *about* an item, as one value. Kept together so
 * selecting a different item, cancelling an edit or loading from History resets
 * or restores all of it at once — three loose useState fields previously leaked
 * crafting choices between items and dropped them on edit.
 */
interface ItemConfig {
  catalyst: boolean
  crafted: boolean
  craftedStats: number[]
  craftingQuality: number
  embellishmentBonusId: number | null
  gemIds: number[]
  enchantId: number | null
}

const EMPTY_CONFIG: ItemConfig = {
  catalyst: false,
  crafted: false,
  craftedStats: [],
  craftingQuality: 5,
  embellishmentBonusId: null,
  gemIds: [],
  enchantId: null
}

/** Which enchant slot an item slot maps to; see enchantsForSlot in db2.ts. */
function enchantSlot(slot: string): string {
  const base = slot.replace(/[12]$/, '')
  return base === 'main_hand' || base === 'off_hand' ? 'weapon' : base
}

/** Gems and enchants share a tier shape, so the tier helpers are shared too. */
interface Tiered { tiers: QualityTier[] }

/** Highest crafting quality, which is what a player would actually use. */
function bestTier(entry: Tiered): QualityTier {
  return entry.tiers[entry.tiers.length - 1]!
}

/** Keep the chosen quality when switching to a different gem or enchant. */
function sameTier(entry: Tiered, tier: number | undefined): QualityTier {
  return entry.tiers.find((t) => t.tier === tier) ?? bestTier(entry)
}

/** Tier 0 means the item has no crafting qualities at all. */
function tierLabel(tier: number): string {
  return tier > 0 ? `Quality ${tier}` : 'Standard'
}

export default function ItemPicker({ raw, disabled, onAdd, editItem, onCancelEdit }: { raw: string; disabled: boolean; onAdd: (item: HypotheticalInput) => void; editItem?: HypotheticalInput; onCancelEdit: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [slot, setSlot] = useState('')
  const [items, setItems] = useState<CatalogResult[]>([])
  const [total, setTotal] = useState(0)
  const [season, setSeason] = useState('')
  const [selected, setSelected] = useState<CatalogResult | null>(null)
  const [track, setTrack] = useState('')
  const [ilvl, setIlvl] = useState(0)
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [config, setConfig] = useState<ItemConfig>(EMPTY_CONFIG)
  const [gems, setGems] = useState<Gem[]>([])
  const [enchants, setEnchants] = useState<Enchant[]>([])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  function patch(change: Partial<ItemConfig>): void {
    setConfig((prev) => ({ ...prev, ...change }))
  }

  // Static generated lists — fetched once.
  useEffect(() => {
    let current = true
    void api.gearOptions().then((r) => {
      if (!current || !r.ok) return
      setGems(r.gems)
      setEnchants(r.enchants)
    }).catch(() => { /* the pickers simply stay empty */ })
    return () => { current = false }
  }, [])

  useEffect(() => {
    let current = true
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      void api.searchItems(raw, query, slot).then((response) => {
        if (!current) return
        if (response.ok) { setItems(response.items); setTotal(response.total); setSeason(response.season) }
        else { setItems([]); setError(response.error) }
      }).catch((err: Error) => { if (current) setError(err.message) }).finally(() => { if (current) setLoading(false) })
    }, 180)
    return () => { current = false; clearTimeout(timer) }
  }, [query, slot, raw])
  useEffect(() => { setSelected(null); setConfig(EMPTY_CONFIG); setMessage('') }, [raw])
  useEffect(() => {
    let current = true
    if (editItem?.selection && editItem.selection.kind !== 'crafted') {
      const selection = editItem.selection
      setQuery(String(selection.itemId)); setSlot(''); setMessage('')
      void api.searchItems(raw, String(selection.itemId)).then((r) => {
        if (!current || !r.ok) return
        const item = r.items.find((i) => i.id === selection.itemId)
        if (!item) return
        setSelected(item); setTrack(selection.track); setIlvl(selection.ilvl)
        // Restore every configured field, not just track and level.
        setConfig({
          catalyst: selection.catalyst ?? false,
          crafted: selection.craftingQuality !== undefined || (selection.craftedStats?.length ?? 0) > 0,
          craftedStats: selection.craftedStats ?? [],
          craftingQuality: selection.craftingQuality ?? 5,
          embellishmentBonusId: selection.embellishmentBonusId ?? null,
          gemIds: selection.gemIds ?? [],
          enchantId: selection.enchantId ?? null
        })
      }).catch((err: Error) => { if (current) setError(err.message) })
    }
    return () => { current = false }
  }, [editItem, raw])

  const levels = selected?.variants.filter((v) => v.track === track) ?? []
  const sockets = selected?.sockets ?? 0
  const slotEnchants = selected ? enchants.filter((e) => e.slot === enchantSlot(selected.slot)) : []
  const hasUnsupportedSavedOptions = config.crafted || config.embellishmentBonusId !== null
  /** The gem and quality a chosen item id belongs to. */
  const gemFor = (id: number): { gem: Gem; tier: QualityTier } | undefined => {
    for (const gem of gems) {
      const tier = gem.tiers.find((t) => t.id === id)
      if (tier) return { gem, tier }
    }
    return undefined
  }

  async function add(): Promise<void> {
    if (!selected) return
    setAdding(true); setError('')
    try {
      const response = await api.configureItem(raw, {
        itemId: selected.id, track, ilvl,
        ...(config.catalyst ? { catalyst: true } : {}),
        ...(config.crafted ? { craftedStats: config.craftedStats, craftingQuality: config.craftingQuality } : {}),
        ...(config.embellishmentBonusId !== null ? { embellishmentBonusId: config.embellishmentBonusId } : {}),
        ...(config.gemIds.length ? { gemIds: config.gemIds } : {}),
        ...(config.enchantId !== null ? { enchantId: config.enchantId } : {})
      })
      if (!response.ok) setError(response.error)
      else { onAdd(response.item); setMessage(`${editItem ? 'Updated' : 'Added one copy of'} ${selected.name}, ${track}, item level ${ilvl}.`) }
    } catch (err) { setError((err as Error).message) }
    finally { setAdding(false) }
  }

  return <section className="item-picker" aria-label="Search new gear">
    <h3>Find an item</h3>
    <p className="note">{season} · Choose a drop or tier piece, then its track and item level. Each addition declares one new copy.</p>
    <fieldset disabled={disabled || adding} className="picker-search">
      <label>Search items<input type="search" value={query} placeholder="Item name or ID" onChange={(e) => setQuery(e.target.value)} /></label>
      <label>Item slot<select value={slot} onChange={(e) => setSlot(e.target.value)}><option value="">All slots</option>{['head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs', 'feet', 'finger', 'trinket', 'main_hand', 'off_hand'].map((s) => <option key={s} value={s}>{s.replaceAll('_', ' ')}</option>)}</select></label>
    </fieldset>
    <p className="note" role="status">{loading ? 'Searching…' : `${total.toLocaleString()} matches${total > items.length ? ` · showing first ${items.length}; refine your search` : ''}`}</p>
    <div className="picker-layout">
      <div className="search-results" aria-label="Item search results" aria-busy={loading}>
        {!loading && !items.length ? <p>No items match. Try another name or slot.</p> : null}
        {items.map((item) => <button type="button" key={item.id} className={`search-item ${selected?.id === item.id ? 'active' : ''}`} disabled={disabled || adding || loading} aria-pressed={selected?.id === item.id}
          onClick={() => { setSelected(item); setTrack(item.variants[0]?.track ?? ''); setIlvl(item.variants[0]?.ilvl ?? 0); setConfig(EMPTY_CONFIG); setMessage('') }}>
          <ItemIcon id={item.id} /><span><strong>{item.name}</strong><small>#{item.id} · {item.source ?? 'Advanced import only'}</small></span>
        </button>)}
      </div>
      <fieldset disabled={disabled || adding} className="variant-config">
        <legend>Configure item</legend>
        {selected ? <><div className="item-preview"><ItemIcon id={config.catalyst ? selected.catalystTarget?.id : selected.id} tooltip={{ name: config.catalyst ? selected.catalystTarget?.name : selected.name, ilvl,
          itemString: config.catalyst ? `id=${selected.catalystTarget?.id},redirected_base_stats=${selected.id}` : undefined,
          previewSelection: { itemId: selected.id, track, ilvl, catalyst: config.catalyst, gemIds: config.gemIds,
            ...(config.enchantId !== null ? { enchantId: config.enchantId } : {}) }
        }} /><strong>{config.catalyst ? selected.catalystTarget?.name : selected.name}</strong></div>
          {selected.catalystTarget ? <div className={`catalyst-option ${config.catalyst ? 'converted' : ''}`}>
            <button type="button" className={config.catalyst ? '' : 'ghost'} aria-pressed={config.catalyst}
              onClick={() => patch({ catalyst: !config.catalyst })}>{config.catalyst ? 'Undo tier conversion' : 'Convert to tier set'}</button>
            <p className="note">{config.catalyst ? `Tier bonus from ${selected.catalystTarget.name}. Stats retained from ${selected.name}.` : 'Season 2 Catalyst · keeps the original item’s stats, item level, gems and enchant.'}</p>
          </div> : null}
          {selected.reason ? <p className="note">{selected.reason}</p> : <>
            <label>Upgrade track<select value={track} onChange={(e) => { setTrack(e.target.value); setIlvl(selected.variants.find((v) => v.track === e.target.value)!.ilvl) }}>{[...new Set(selected.variants.map((v) => v.track))].map((t) => <option key={t}>{t}</option>)}</select></label>
            <label>Item level<select aria-label="Item level" value={ilvl} onChange={(e) => setIlvl(Number(e.target.value))}>{levels.map((v) => <option key={v.ilvl} value={v.ilvl}>{v.ilvl} · {v.label ?? `${v.rank}/${v.max}`}</option>)}</select></label>

            {hasUnsupportedSavedOptions ? <div className="warn" role="alert">
              <p>This saved guided item contains crafting or embellishment choices whose eligibility is not verified. It will be rejected until you review and remove them.</p>
              <button type="button" className="ghost" onClick={() => patch({ crafted: false, craftedStats: [], embellishmentBonusId: null })}>Remove unsupported options</button>
            </div> : <p className="note">Crafted items and embellishments require an exact SimC item string under Advanced import.</p>}

            {/* Gems — one per socket the item actually has. */}
            <div className="gear-addon" aria-label="Gems">
              <div className="gear-addon-head">
                <span>Gems {sockets ? <small>{config.gemIds.length}/{sockets} sockets</small> : null}</span>
                <button type="button" className="add" aria-label="Add gem"
                  disabled={!sockets || config.gemIds.length >= sockets || !gems.length}
                  onClick={() => patch({ gemIds: [...config.gemIds, bestTier(gems[0]!).id] })}>+</button>
              </div>
              {!sockets ? <p className="note">This item has no sockets.</p> : null}
              {config.gemIds.map((gemId, i) => {
                const found = gemFor(gemId)
                const setGem = (id: number): void => patch({ gemIds: config.gemIds.map((g, j) => j === i ? id : g) })
                return <div key={i} className="gear-addon-row">
                  <ItemIcon name={found?.tier.icon} />
                  <select aria-label={`Gem ${i + 1}`} value={found?.gem.name ?? ''}
                    onChange={(e) => {
                      const next = gems.find((g) => g.name === e.target.value)
                      if (next) setGem(sameTier(next, found?.tier.tier).id)
                    }}>
                    {gems.map((g) => <option key={g.name} value={g.name}>{g.name} — {g.effect}</option>)}
                  </select>
                  {found && found.gem.tiers.length > 1 ? <select aria-label={`Gem ${i + 1} quality`} value={gemId}
                    onChange={(e) => setGem(Number(e.target.value))}>
                    {found.gem.tiers.map((t) => <option key={t.id} value={t.id}>{tierLabel(t.tier)}</option>)}
                  </select> : null}
                  <button type="button" className="ghost" aria-label={`Remove gem ${i + 1}`}
                    onClick={() => patch({ gemIds: config.gemIds.filter((_, j) => j !== i) })}>Remove</button>
                </div>
              })}
            </div>

            {/* Enchants — slot list is name-derived and incomplete. */}
            <div className="gear-addon" aria-label="Enchant options">
              <div className="gear-addon-head">
                <span>Enchant</span>
                {config.enchantId === null
                  ? <button type="button" className="add" aria-label="Add enchant"
                      disabled={!slotEnchants.length}
                      onClick={() => patch({ enchantId: slotEnchants[0] ? bestTier(slotEnchants[0]).id : null })}>+</button>
                  : <button type="button" className="ghost" onClick={() => patch({ enchantId: null })}>Remove</button>}
              </div>
              {!slotEnchants.length
                ? <p className="note">No enchants are known for this slot yet. Enchant slots are derived from names and cover only some slots; use advanced import for an exact string.</p>
                : config.enchantId !== null ? (() => {
                    const current = slotEnchants.find((e) => e.tiers.some((t) => t.id === config.enchantId))
                    const tier = current?.tiers.find((t) => t.id === config.enchantId)
                    return <div className="gear-addon-row">
                      <ItemIcon name={tier?.icon} />
                      <select aria-label="Enchant" value={current?.name ?? ''}
                        onChange={(e) => {
                          const next = slotEnchants.find((x) => x.name === e.target.value)
                          if (next) patch({ enchantId: sameTier(next, tier?.tier).id })
                        }}>
                        {slotEnchants.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
                      </select>
                      {current && current.tiers.length > 1 ? <select aria-label="Enchant quality" value={config.enchantId}
                        onChange={(e) => patch({ enchantId: Number(e.target.value) })}>
                        {current.tiers.map((t) => <option key={t.id} value={t.id}>{tierLabel(t.tier)}</option>)}
                      </select> : null}
                    </div>
                  })() : null}
            </div>

            <button type="button" onClick={() => void add()}>{adding ? 'Saving…' : editItem ? 'Save item changes' : 'Add item to gear'}</button>
          </>}
        </> : <p className="note">Select a search result to see its available tracks.</p>}
        {editItem ? <button type="button" className="ghost" onClick={() => { setConfig(EMPTY_CONFIG); onCancelEdit() }}>Cancel edit</button> : null}
      </fieldset>
    </div>
    {message ? <p className="gain" role="status">{message}</p> : null}
    {error ? <p className="err" role="alert">{error}</p> : null}
  </section>
}
