import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ItemStatState } from '../../core/data/itemStats.ts'
import { createPortal } from 'react-dom'
import type { SimItBoiApi } from '../../core/api.ts'
import type { ItemSelection } from '../../core/topgear/hypothetical.ts'
import bundled from './tooltip-data.json'
interface Metadata { name?: string; quality?: string; slot?: string; armor?: string; setId?: number; source?: string; effects?: string[] }
interface ItemSet { name: string; items: number[]; members?: { id: number; name: string }[]; effects?: { required: number; text?: string }[] }
const metadata = bundled.items as Record<string, Metadata>
const sets = bundled.sets as Record<string, ItemSet>
const NestedTooltip = createContext(false)
const ROW_SELECTOR = '.candidate, .search-item, .item-preview, .hypothetical-list li, .gear-addon-row, table.gear tr'
export const EquippedItems = createContext<number[] | undefined>(undefined)
export const ItemPreviewProfile = createContext('')
export const useInsideTooltip = (): boolean => useContext(NestedTooltip)
export interface ItemTooltipData {
  id?: number; name: string; ilvl?: number; slot?: string; quality?: string; itemString?: string
  stats?: Array<{ name: string; value: number }>; statState?: ItemStatState; notes?: string[]
  previewSelection?: ItemSelection
  previewNote?: string
}
export function itemDisplayName(id?: number, icon?: string | null): string {
  if (id && metadata[id]?.name) return metadata[id].name!
  const addon = [...bundled.gems, ...bundled.enchants].find(e => e.tiers.some(t => t.icon === icon && icon))
  return addon?.name ?? bundled.embellishments.find(e => e.icon === icon && icon)?.name ?? (id ? `Item ${id}` : 'Item enhancement')
}
export function ItemTooltipCard({ data }: { data: ItemTooltipData }): JSX.Element {
  const raw = useContext(ItemPreviewProfile)
  const [preview, setPreview] = useState<{ key: string; state: ItemStatState; note?: string }>()
  const equipped = useContext(EquippedItems)
  const id = data.id ?? Number(data.itemString?.match(/(?:^|,)id=(\d+)/)?.[1] ?? 0)
  const meta = metadata[id] ?? {}
  const set = meta.setId ? sets[meta.setId] : undefined
  const count = equipped ? new Set(equipped.filter(i => set?.items.includes(i))).size : undefined
  const requestKey = JSON.stringify(data.previewSelection ? { selection: data.previewSelection } : data.itemString ? { itemString: data.itemString } : { id })
  const hasKnownStats = Boolean(data.stats?.length || data.statState?.status === 'available')
  useEffect(() => {
    if (!raw || hasKnownStats || !id) return
    const api = (window as unknown as { simitboi: SimItBoiApi }).simitboi
    if (typeof api.itemPreview !== 'function') {
      setPreview({ key: requestKey, state: { status: 'failed', reason: 'Restart SimItBoi to load item stat previews.' } })
      return
    }
    const request = JSON.parse(requestKey)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    setPreview({ key: requestKey, state: { status: 'pending' } })
    const read = async (): Promise<void> => {
      try {
        const response = await api.itemPreview(raw, request)
        if (cancelled) return
        const state: ItemStatState = response.ok ? response.state : { status: 'failed', reason: response.error }
        setPreview({ key: requestKey, state, note: response.ok ? response.note : undefined })
        if (state.status === 'pending') timer = setTimeout(() => void read(), 500)
      } catch (error) {
        if (!cancelled) setPreview({ key: requestKey, state: { status: 'failed', reason: (error as Error).message } })
      }
    }
    timer = setTimeout(() => void read(), 120)
    return () => { cancelled = true; clearTimeout(timer); void api.itemPreview(raw, request, true).catch(() => {}) }
  }, [raw, requestKey, hasKnownStats, id])
  const state = hasKnownStats ? data.statState : preview?.key === requestKey ? preview.state : data.statState
  const stats = state?.status === 'available' ? state.stats : data.stats
  const ilvl = state?.status === 'available' ? state.ilvl ?? data.ilvl : data.ilvl
  const tokens: Record<string, string> = Object.fromEntries((data.itemString ?? '').split(',').map(t => t.split('=')))
  const originalId = Number(tokens.redirected_base_stats)
  const gemIds = (tokens.gem_id ?? '').split('/').map(Number).filter(Boolean)
  const gems = gemIds.map(id => ({ id, gem: bundled.gems.find(g => g.tiers.some(t => t.id === id)) }))
  const enchant = bundled.enchants.find(e => e.tiers.some(t => t.id === Number(tokens.enchant_id)))
  const bonuses = (tokens.bonus_id ?? '').split('/').map(Number)
  const embellishments = bundled.embellishments.filter(e => bonuses.includes(e.bonusId))
  const sockets = ((bundled.sockets as Record<string, number[]>)[id]?.length ?? 0) + bonuses.reduce((n, b) => n + ((bundled.socketBonuses as Record<string, {count: number}>)[b]?.count ?? 0), 0)
  const unavailable = state?.status === 'failed' || state?.status === 'missing' ? state.reason
    : state?.status === 'available' ? 'This item has no numeric item-row stats.'
      : raw && id ? 'Reading item stats…' : 'No numeric stats available for this item.'
  return <div className={`item-tip quality-${data.quality ?? meta.quality ?? 'unknown'}`}>
    <div className="tip-name">{data.name || meta.name || `Item ${id}`}</div>
    {(ilvl || Number(tokens.ilevel)) ? <div className="tip-ilvl">Item level {ilvl || Number(tokens.ilevel)}</div> : null}
    {data.previewNote || (preview?.key === requestKey && preview.note) ? <div className="tip-nostats">{data.previewNote ?? preview?.note}</div> : null}
    <div className="tip-meta"><span>{(data.slot ?? meta.slot)?.replaceAll('_', ' ')}</span><span>{meta.armor}</span></div>
    {data.notes?.map(n => <div className="tip-note" key={n}>{n}</div>)}
    {originalId ? <div className="tip-catalyst">Catalyzed · stats from {itemDisplayName(originalId)}</div> : null}
    {stats?.length ? <dl className="tip-stats">{stats.map(s => <div key={s.name}><dd>+{Math.round(s.value).toLocaleString()}</dd><dt>{s.name}</dt></div>)}</dl> : <p className="tip-nostats">{unavailable}</p>}
    {stats?.length ? <p className="tip-nostats">Item-row stats only; gem and enchant effects are not included here.</p> : null}
    {enchant || tokens.enchant_id ? <div className="tip-effect">Enchanted: {enchant?.name ?? `Enchant ${tokens.enchant_id}`}</div> : null}
    {gems.map(({ id, gem }, i) => <div className="tip-effect" key={i}>◆ {gem?.name ?? `Gem ${id}`}{gem?.effect ? ` — ${gem.effect}` : ''}</div>)}
    {Array.from({ length: Math.max(0, Math.min(3, sockets - gems.length)) }, (_, i) => <div className="tip-empty" key={i}>◇ Empty socket</div>)}
    {embellishments.map(e => <div className="tip-effect" key={e.bonusId}>Embellished: {e.name}</div>)}
    {meta.effects?.map((e, i) => <div className="tip-effect" key={i}>{e}</div>)}
    {set ? <section className="tip-set"><div className="tip-set-name">{set.name} {count !== undefined ? `(${count}/${set.items.length})` : ''}</div>
      {set.members?.map(m => <div key={m.id} className={equipped?.includes(m.id) ? 'tip-equipped' : 'tip-inactive'}>{m.name}</div>)}
      <div className="tip-nostats">Blizzard reference bonuses · specialization not resolved</div>{set.effects?.length ? set.effects.map((e, i) => <div key={i} className={`tip-set-bonus ${count !== undefined && count >= e.required ? 'tip-effect' : 'tip-inactive'}`}>({e.required}) {e.text ?? 'Bonus description unavailable.'}</div>) : <div className="tip-inactive">Set bonus descriptions unavailable in bundled data.</div>}
      <div className="tip-nostats">{count === undefined ? 'Equip count unavailable in this view. ' : 'Count uses equipped gear, not candidate selections. '}Bonus text from Blizzard; values may vary by specialization and level.</div>
    </section> : null}
    {meta.source ? <div className="tip-source">{meta.source}</div> : null}
    {id ? <div className="tip-nostats">Item ID {id}</div> : null}
    {data.itemString ? <code className="tip-string">{data.itemString}</code> : null}
  </div>
}
export default function ItemTooltip({ data, children }: { data: ItemTooltipData; children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>()
  const id = useId()
  function dismiss(force = false): void {
    clearTimeout(dismissTimer.current)
    dismissTimer.current = setTimeout(() => {
      const target = anchor.current?.closest(ROW_SELECTOR) ?? anchor.current
      const focused = target?.contains(document.activeElement)
      const hovered = target?.matches(':hover') || popup.current?.matches(':hover')
      if (force || (!focused && !hovered)) setOpen(false)
    }, 100)
  }
  useEffect(() => {
    const el = anchor.current!
    // Rows remain hoverable even when their selection button/checkbox is disabled.
    const target = el.closest(ROW_SELECTOR) ?? el
    const show = (): void => {
      clearTimeout(dismissTimer.current)
      document.dispatchEvent(new CustomEvent('simitboi:item-tooltip-open', { detail: id }))
      setOpen(true)
    }
    const otherOpened = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== id) { clearTimeout(dismissTimer.current); setOpen(false) }
    }
    const selected = (): void => {
      // Selecting a search result reveals its configuration panel. Keep that
      // panel clickable even while the selected search button retains focus.
      if (target.matches('.search-item')) { clearTimeout(dismissTimer.current); setOpen(false) }
    }
    const hide = (): void => dismiss()
    const key = (e: Event): void => { if ((e as KeyboardEvent).key === 'Escape') dismiss(true) }
    target.addEventListener('mouseenter', show); target.addEventListener('mouseleave', hide)
    target.addEventListener('focusin', show); target.addEventListener('focusout', hide)
    target.addEventListener('click', selected)
    document.addEventListener('keydown', key)
    document.addEventListener('simitboi:item-tooltip-open', otherOpened)
    return () => { clearTimeout(dismissTimer.current); target.removeEventListener('mouseenter', show); target.removeEventListener('mouseleave', hide); target.removeEventListener('focusin', show); target.removeEventListener('focusout', hide); target.removeEventListener('click', selected); document.removeEventListener('keydown', key); document.removeEventListener('simitboi:item-tooltip-open', otherOpened) }
  }, [])
  useLayoutEffect(() => {
    if (!open) return
    const position = (): void => {
      const el = popup.current; if (!el) return
      // Position outside the whole trigger row. Anchoring to its icon can put the
      // overlay on top of the button between pointer-down and click.
      const target = anchor.current!.closest(ROW_SELECTOR) ?? anchor.current!
      const rect = target.getBoundingClientRect()
      if (rect.width === 0) { setOpen(false); return }
      const width = el.offsetWidth
      let left: number, top: number
      const fitsRight = rect.right + 12 + width <= window.innerWidth - 8
      const fitsLeft = rect.left - width - 12 >= 8
      if (fitsRight || fitsLeft) {
        el.style.maxHeight = `${window.innerHeight - 16}px`
        left = fitsRight ? rect.right + 12 : rect.left - width - 12
        top = Math.max(8, Math.min(rect.top, window.innerHeight - el.offsetHeight - 8))
      } else {
        const above = Math.max(0, rect.top - 20)
        const below = Math.max(0, window.innerHeight - rect.bottom - 20)
        const placeBelow = below >= above
        el.style.maxHeight = `${Math.min(window.innerHeight - 16, Math.max(40, placeBelow ? below : above))}px`
        left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
        top = placeBelow ? rect.bottom + 12 : rect.top - el.offsetHeight - 12
      }
      el.style.left = `${left}px`
      el.style.top = `${Math.max(8, Math.min(top, window.innerHeight - el.offsetHeight - 8))}px`
    }
    position()
    const observer = new ResizeObserver(position); observer.observe(popup.current!)
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open])
  return <NestedTooltip.Provider value={true}><span ref={anchor} className="item-tip-anchor" tabIndex={0} aria-describedby={open ? id : undefined}>
    {children}{open ? createPortal(<div ref={popup} id={id} role="tooltip" className="item-tip-position"
      onMouseEnter={() => clearTimeout(dismissTimer.current)} onMouseLeave={() => dismiss()}
      onClick={e => e.stopPropagation()}><ItemTooltipCard data={data} /></div>, document.body) : null}
  </span></NestedTooltip.Provider>
}
