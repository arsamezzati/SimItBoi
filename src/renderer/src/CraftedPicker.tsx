import { useEffect, useState } from 'react'
import type { CraftedOption, EmbellishmentOption, SimItBoiApi } from '../../core/api.ts'
import type { Enchant, Gem, QualityTier } from '../../core/data/db2.ts'
import type { CraftedSelection } from '../../core/data/crafted.ts'
import type { HypotheticalInput } from '../../core/topgear/hypothetical.ts'
import ItemIcon from './ItemIcon.tsx'

const api = (window as unknown as { simitboi: SimItBoiApi }).simitboi

/**
 * One crafted configuration, held together so switching item or cancelling an
 * edit resets all of it at once — the same shape as the track picker's config.
 */
interface CraftedConfig {
  ladderBonusId: number
  craftingQuality: number
  craftedStats: number[]
  embellishmentBonusId: number | null
  gemIds: number[]
  enchantId: number | null
}

/** Crafted stats are exactly two; the picker enforces that before submitting. */
const MAX_STATS = 2

function defaultsFor(recipe: CraftedOption): CraftedConfig {
  return {
    // Top of the ladder: what a player would actually craft.
    ladderBonusId: recipe.ilvlLadder[recipe.ilvlLadder.length - 1]!.bonusId,
    craftingQuality: 5,
    craftedStats: [],
    embellishmentBonusId: null,
    gemIds: [],
    enchantId: null
  }
}

/** Which enchant slot an item slot maps to; mirrors enchantSlot in db2.ts. */
function enchantSlotFor(slot: string): string {
  const base = slot.replace(/[12]$/, '')
  if (base === 'one_hand' || base === 'two_hand' || base === 'main_hand' || base === 'off_hand') return 'weapon'
  if (base === 'shield' || base === 'holdable') return 'weapon'
  return base
}

function bestTier(entry: { tiers: QualityTier[] }): QualityTier {
  return entry.tiers[entry.tiers.length - 1]!
}

export default function CraftedPicker({ raw, disabled, onAdd, editItem, onCancelEdit }: {
  raw: string; disabled: boolean
  onAdd: (item: HypotheticalInput) => void
  editItem?: HypotheticalInput
  onCancelEdit: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [slot, setSlot] = useState('')
  const [items, setItems] = useState<CraftedOption[]>([])
  const [total, setTotal] = useState(0)
  const [statOptions, setStatOptions] = useState<Array<{ id: number; name: string }>>([])
  const [selected, setSelected] = useState<CraftedOption | null>(null)
  const [config, setConfig] = useState<CraftedConfig | null>(null)
  const [embellishments, setEmbellishments] = useState<EmbellishmentOption[]>([])
  const [gems, setGems] = useState<Gem[]>([])
  const [enchants, setEnchants] = useState<Enchant[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  function patch(change: Partial<CraftedConfig>): void {
    setConfig((prev) => (prev ? { ...prev, ...change } : prev))
  }

  useEffect(() => {
    let current = true
    void api.gearOptions().then((r) => {
      if (!current || !r.ok) return
      setEmbellishments(r.embellishments); setGems(r.gems); setEnchants(r.enchants)
    }).catch(() => { /* the pickers stay empty */ })
    return () => { current = false }
  }, [])

  useEffect(() => {
    let current = true
    setLoading(true); setError('')
    const timer = setTimeout(() => {
      void api.craftableItems(raw, query, slot).then((r) => {
        if (!current) return
        if (r.ok) { setItems(r.items); setTotal(r.total); setStatOptions(r.stats) }
        else { setItems([]); setError(r.error) }
      }).catch((err: Error) => { if (current) setError(err.message) })
        .finally(() => { if (current) setLoading(false) })
    }, 180)
    return () => { current = false; clearTimeout(timer) }
  }, [query, slot, raw])

  useEffect(() => { setSelected(null); setConfig(null); setMessage('') }, [raw])

  // Restoring an edit: re-find the recipe, then put every choice back.
  useEffect(() => {
    let current = true
    const selection = editItem?.selection
    if (selection && selection.kind === 'crafted') {
      setQuery(String(selection.itemId)); setSlot(''); setMessage('')
      void api.craftableItems(raw, String(selection.itemId)).then((r) => {
        if (!current || !r.ok) return
        const recipe = r.items.find((i) => i.itemId === selection.itemId)
        if (!recipe) return
        setSelected(recipe)
        setConfig({
          ladderBonusId: selection.ladderBonusId,
          craftingQuality: selection.craftingQuality,
          craftedStats: [...selection.craftedStats],
          embellishmentBonusId: selection.embellishmentBonusId ?? null,
          gemIds: [...(selection.gemIds ?? [])],
          enchantId: selection.enchantId ?? null
        })
      }).catch((err: Error) => { if (current) setError(err.message) })
    }
    return () => { current = false }
  }, [editItem, raw])

  // Decided per recipe in the main process: the same equipment slot covers
  // recipes of different expansions, armor classes and professions.
  const legalEmbellishments = selected
    ? embellishments.filter((e) => selected.embellishmentBonusIds.includes(e.bonusId))
    : []
  const slotEnchants = selected
    ? enchants.filter((e) => e.slot === enchantSlotFor(selected.slot))
    : []
  const sockets = selected?.sockets ?? 0
  const gemFor = (id: number): { gem: Gem; tier: QualityTier } | undefined => {
    for (const gem of gems) {
      const tier = gem.tiers.find((t) => t.id === id)
      if (tier) return { gem, tier }
    }
    return undefined
  }

  async function add(): Promise<void> {
    if (!selected || !config) return
    setAdding(true); setError('')
    try {
      const selection: CraftedSelection = {
        kind: 'crafted',
        itemId: selected.itemId,
        ladderBonusId: config.ladderBonusId,
        craftingQuality: config.craftingQuality,
        craftedStats: config.craftedStats,
        ...(config.embellishmentBonusId !== null ? { embellishmentBonusId: config.embellishmentBonusId } : {}),
        ...(config.gemIds.length ? { gemIds: config.gemIds } : {}),
        ...(config.enchantId !== null ? { enchantId: config.enchantId } : {})
      }
      const response = await api.configureCrafted(raw, selection)
      if (!response.ok) setError(response.error)
      else {
        onAdd(response.item)
        setMessage(`${editItem ? 'Updated' : 'Added'} ${selected.name}.`)
      }
    } catch (err) { setError((err as Error).message) }
    finally { setAdding(false) }
  }

  const step = selected && config
    ? selected.ilvlLadder.find((l) => l.bonusId === config.ladderBonusId)
    : undefined

  return <section className="item-picker" aria-label="Craft an item">
    <p className="note">
      Crafted gear. Item level comes from the Dawncrest infusion, and crafting quality is a separate
      choice. Pick exactly two secondary stats.
    </p>
    <fieldset disabled={disabled || adding} className="picker-search">
      <label>Search crafted items<input type="search" value={query} placeholder="Item name or ID" onChange={(e) => setQuery(e.target.value)} /></label>
      <label>Item slot<select value={slot} onChange={(e) => setSlot(e.target.value)}>
        <option value="">All slots</option>
        {['head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs', 'feet', 'finger', 'trinket', 'one_hand', 'two_hand', 'ranged', 'shield', 'holdable'].map((s) =>
          <option key={s} value={s}>{s.replaceAll('_', ' ')}</option>)}
      </select></label>
    </fieldset>
    <p className="note" role="status">{loading ? 'Searching…' : `${total.toLocaleString()} craftable items${total > items.length ? ` · showing first ${items.length}` : ''}`}</p>
    <div className="picker-layout">
      <div className="search-results" aria-label="Crafted item results" aria-busy={loading}>
        {!loading && !items.length ? <p>No craftable items match.</p> : null}
        {items.map((item) => <button type="button" key={item.itemId}
          className={`search-item ${selected?.itemId === item.itemId ? 'active' : ''}`}
          disabled={disabled || adding || loading} aria-pressed={selected?.itemId === item.itemId}
          onClick={() => { setSelected(item); setConfig(defaultsFor(item)); setMessage('') }}>
          <ItemIcon id={item.itemId} />
          <span><strong>{item.name}</strong><small>#{item.itemId} · {item.category}</small></span>
        </button>)}
      </div>
      <fieldset disabled={disabled || adding} className="variant-config">
        <legend>Configure craft</legend>
        {selected && config ? <>
          <div className="item-preview"><ItemIcon id={selected.itemId} tooltip={{ name: selected.name, ilvl: step?.ilvl,
            previewSelection: { kind: 'crafted', itemId: selected.itemId, ladderBonusId: config.ladderBonusId,
              craftingQuality: config.craftingQuality, craftedStats: config.craftedStats.length === 2 ? config.craftedStats : [32, 36],
              gemIds: config.gemIds, ...(config.enchantId !== null ? { enchantId: config.enchantId } : {}),
              ...(config.embellishmentBonusId !== null ? { embellishmentBonusId: config.embellishmentBonusId } : {}) },
            previewNote: config.craftedStats.length !== 2 ? 'Preview uses Critical Strike / Haste until you choose two stats.' : undefined
          }} /><strong>{selected.name}</strong></div>

          <label>Dawncrest infusion
            <select aria-label="Dawncrest infusion" value={config.ladderBonusId}
              onChange={(e) => patch({ ladderBonusId: Number(e.target.value) })}>
              {selected.ilvlLadder.map((l) => <option key={l.bonusId} value={l.bonusId}>{l.label}</option>)}
            </select>
          </label>

          <label>Crafting quality
            <select aria-label="Crafting quality" value={config.craftingQuality}
              onChange={(e) => patch({ craftingQuality: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5].map((q) => <option key={q} value={q}>Quality {q}</option>)}
            </select>
          </label>

          <fieldset className="crafted-stats">
            <legend>Crafted stats <span>pick exactly two</span></legend>
            {statOptions.map((stat) => {
              const on = config.craftedStats.includes(stat.id)
              return <label key={stat.id} className="checkbox">
                <input type="checkbox" checked={on} disabled={!on && config.craftedStats.length >= MAX_STATS}
                  onChange={(e) => patch({
                    craftedStats: e.target.checked
                      ? [...config.craftedStats, stat.id]
                      : config.craftedStats.filter((id) => id !== stat.id)
                  })} />
                {stat.name}
              </label>
            })}
          </fieldset>

          <div className="gear-addon" aria-label="Embellishment options">
            <div className="gear-addon-head">
              <span>Embellishment</span>
              {config.embellishmentBonusId === null
                ? <button type="button" className="add" aria-label="Add embellishment"
                    disabled={!selected.canEmbellish || !legalEmbellishments.length}
                    onClick={() => patch({ embellishmentBonusId: legalEmbellishments[0]?.bonusId ?? null })}>+</button>
                : <button type="button" className="ghost" onClick={() => patch({ embellishmentBonusId: null })}>Remove</button>}
            </div>
            {!selected.canEmbellish
              ? <p className="note">This recipe does not take an embellishment.</p>
              : config.embellishmentBonusId !== null
                ? <div className="gear-addon-row">
                    <ItemIcon name={legalEmbellishments.find((e) => e.bonusId === config.embellishmentBonusId)?.icon} />
                    <select aria-label="Embellishment" value={config.embellishmentBonusId}
                      onChange={(e) => patch({ embellishmentBonusId: Number(e.target.value) })}>
                      {legalEmbellishments.map((e) => <option key={e.bonusId} value={e.bonusId}>{e.name}</option>)}
                    </select>
                  </div>
                : <p className="note">{legalEmbellishments.length} allowed on {selected.slot.replaceAll('_', ' ')} · counts toward the cap of two.</p>}
          </div>

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
              return <div key={i} className="gear-addon-row">
                <ItemIcon name={found?.tier.icon} />
                <select aria-label={`Gem ${i + 1}`} value={gemId}
                  onChange={(e) => patch({ gemIds: config.gemIds.map((g, j) => j === i ? Number(e.target.value) : g) })}>
                  {gems.map((g) => <option key={g.name} value={bestTier(g).id}>{g.name} — {g.effect}</option>)}
                </select>
                <button type="button" className="ghost" aria-label={`Remove gem ${i + 1}`}
                  onClick={() => patch({ gemIds: config.gemIds.filter((_, j) => j !== i) })}>Remove</button>
              </div>
            })}
          </div>

          <div className="gear-addon" aria-label="Enchant options">
            <div className="gear-addon-head">
              <span>Enchant</span>
              {config.enchantId === null
                ? <button type="button" className="add" aria-label="Add enchant" disabled={!slotEnchants.length}
                    onClick={() => patch({ enchantId: slotEnchants[0] ? bestTier(slotEnchants[0]).id : null })}>+</button>
                : <button type="button" className="ghost" onClick={() => patch({ enchantId: null })}>Remove</button>}
            </div>
            {!slotEnchants.length
              ? <p className="note">No enchants are known for this slot yet.</p>
              : config.enchantId !== null
                ? <div className="gear-addon-row">
                    <select aria-label="Enchant" value={config.enchantId}
                      onChange={(e) => patch({ enchantId: Number(e.target.value) })}>
                      {slotEnchants.flatMap((e) => e.tiers.map((t) => (
                        <option key={t.id} value={t.id}>{e.name}{e.tiers.length > 1 ? ` · quality ${t.tier}` : ''}</option>
                      )))}
                    </select>
                  </div>
                : null}
          </div>

          <p className="note">
            {step ? `Resolves to item level ${step.ilvl}.` : null}
            {config.craftedStats.length !== MAX_STATS ? ' Choose two stats to continue.' : null}
          </p>
          <button type="button" disabled={config.craftedStats.length !== MAX_STATS} onClick={() => void add()}>
            {adding ? 'Saving…' : editItem ? 'Save craft changes' : 'Add crafted item'}
          </button>
        </> : <p className="note">Select a craftable item to configure it.</p>}
        {editItem ? <button type="button" className="ghost" onClick={() => { setSelected(null); setConfig(null); onCancelEdit() }}>Cancel edit</button> : null}
      </fieldset>
    </div>
    {message ? <p className="gain" role="status">{message}</p> : null}
    {error ? <p className="err" role="alert">{error}</p> : null}
  </section>
}
