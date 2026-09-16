import { useEffect, useMemo, useState } from 'react'
import type { SimItBoiApi } from '../../core/api.ts'
import type { CandidateOption, TopGearProgress, TopGearResult } from '../../core/topgear/funnel.ts'
import type { HypotheticalInput, ItemSelection } from '../../core/topgear/hypothetical.ts'

/** Crafted selections carry their level for display; track ones always have it. */
function selectionIlvl(selection: ItemSelection): number | undefined {
  return selection.ilvl
}
import Report from './Report.tsx'
import ItemPicker from './ItemPicker.tsx'
import CraftedPicker from './CraftedPicker.tsx'
import ItemIcon, { itemId } from './ItemIcon.tsx'
import ItemTooltip, { EquippedItems } from './ItemTooltip.tsx'
import type { ItemStatState } from '../../core/data/itemStats.ts'
import { DEFAULT_FIGHT_SECONDS, SEARCH_TIMES, fightLengthOptions } from './simPresets.ts'

const api = (window as unknown as { simitboi: SimItBoiApi }).simitboi
const label = (slot: string): string => slot.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
const fmt = (n: number): string => Math.round(n).toLocaleString()
function statSummary(state: ItemStatState | undefined): string {
  if (!state) return 'Stats unavailable'
  if (state.status === 'pending') return 'Reading stats…'
  if (state.status === 'available') return state.stats.map((stat) => `+${Math.round(stat.value).toLocaleString()} ${stat.name}`).join(' · ') || 'No numeric item-row stats'
  return state.reason
}

export default function TopGear({ raw, candidates, running, setRunning, logicalThreads, restored }: {
  restored?: TopGearResult | null
  raw: string; candidates: CandidateOption[]; running: boolean; setRunning: (value: boolean) => void; logicalThreads: number
}): JSX.Element {
  const floor = Math.max(0, Math.min(...candidates.filter((c) => c.source === 'equipped' && c.ilvl > 0).map((c) => c.ilvl), 999) - 30)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  /** Gear the player does not own but wants to evaluate. */
  const [hypothetical, setHypothetical] = useState<HypotheticalInput[]>([])
  const [catalystNote, setCatalystNote] = useState<string | null>(null)
  const [loadingCatalyst, setLoadingCatalyst] = useState(false)

  /**
   * Season 2 conversions keep the item level and stats of the piece they were
   * made from, so every owned piece is a different tier stat split. Adding them
   * as candidates is what lets the search weigh set bonuses against stats.
   */
  async function addCatalystOptions(): Promise<void> {
    setLoadingCatalyst(true)
    setCatalystNote(null)
    try {
      const r = await api.catalystOptions(raw)
      if (!r.ok) { setCatalystNote(r.error); return }
      let added = 0
      setHypothetical((previous) => {
        const known = new Set(previous.map((h) => h.itemString))
        const fresh = r.options.filter((o) => !known.has(o.itemString))
        added = fresh.length
        return [...previous, ...fresh]
      })
      setCatalystNote(r.options.length === 0
        ? "Nothing you own can be converted into this season's tier set."
        : added === 0 ? 'Every conversion is already in the list.' : 'Added ' + added + ' conversion' + (added === 1 ? '' : 's') + '.')
    } finally {
      setLoadingCatalyst(false)
    }
  }
  const [editing, setEditing] = useState<number | null>(null)
  /** Drops and crafts are configured differently, so they get separate pickers. */
  const [pickerMode, setPickerMode] = useState<'drop' | 'crafted'>('drop')
  /** Real stats per exact variant+placement for hover detail. */
  const [itemStats, setItemStats] = useState<Record<string, ItemStatState>>({})
  const [draft, setDraft] = useState('')
  const [draftLabel, setDraftLabel] = useState('')
  const [draftEmbellished, setDraftEmbellished] = useState<boolean | undefined>(undefined)
  const [budget, setBudget] = useState(180)
  const [threads, setThreads] = useState(Math.max(1, logicalThreads - 2))
  const [fightSeconds, setFightSeconds] = useState(DEFAULT_FIGHT_SECONDS)
  const [targets, setTargets] = useState(1)
  const [progress, setProgress] = useState<TopGearProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TopGearResult | null>(null)
  useEffect(() => {
    setSelected(new Set(candidates.filter((c) => c.source === 'equipped' || (c.supported && c.ilvl >= floor)).map((c) => c.id)))
    setHypothetical([]); setEditing(null); setResult(null); setError(null); setProgress(null)
  }, [raw, candidates, floor])
  useEffect(() => setThreads(Math.max(1, logicalThreads - 2)), [logicalThreads])
  useEffect(() => {
    if (!restored || restored.input !== raw) return
    setSelected(new Set(restored.options?.selectedIds ?? restored.selectedIds))
    setHypothetical(restored.options?.hypothetical ?? (restored.hypotheticalAccepted ?? []).map((h) => ({ itemString: h.itemString, label: h.name, embellished: h.embellished })))
    setBudget(restored.settings.budgetSeconds); setThreads(Math.min(logicalThreads, restored.settings.threads))
    setFightSeconds(restored.settings.fightSeconds); setTargets(restored.settings.targets); setResult(restored)
  }, [restored, raw, candidates, logicalThreads])
  useEffect(() => api.onTopGearProgress(setProgress), [])
  // Real stats for hover detail. Slot-packed, so a full bag is under a
  // second. A whole-probe failure used to be swallowed, which left every
  // tooltip claiming its stats were still being simulated forever; it is now a
  // failed state carrying the reason.
  useEffect(() => {
    let cancelled = false
    setItemStats(Object.fromEntries(candidates.map((candidate) => [candidate.statKey, { status: 'pending' } satisfies ItemStatState])))
    if (!raw.trim()) return
    void api.itemStats(raw).then((r) => {
      if (cancelled) return
      // An empty map with candidates to probe means the background job yielded
      // to a foreground simulation; that is also something a retry can fix.
      const yielded = r.ok && candidates.length > 0 && Object.keys(r.stats).length === 0
      if (r.ok && !yielded) { setItemStats(r.stats); return }
      const reason = r.ok ? 'Stats were set aside while a simulation ran.' : r.error
      setItemStats(Object.fromEntries(candidates.map((candidate) =>
        [candidate.statKey, { status: 'failed', reason } satisfies ItemStatState])))
    })
    return () => { cancelled = true; void api.cancelItemStats(raw) }
  }, [raw, candidates])
  const groups = useMemo(() => {
    const map = new Map<string, CandidateOption[]>()
    for (const item of candidates) {
      const slot = ['main_hand', 'off_hand'].includes(item.slot) ? 'weapons' : item.slot
      map.set(slot, [...(map.get(slot) ?? []), item])
    }
    return [...map]
  }, [candidates])
  async function run(): Promise<void> {
    setRunning(true); setError(null); setProgress({ stage: 'Starting', fraction: 0, detail: 'Preparing selected gear' })
    try {
      const response = await api.runTopGear(raw, { selectedIds: [...selected], budgetSeconds: budget, threads, fightSeconds, targets, hypothetical })
      if (!response.ok) setError(response.error)
      else { setResult(response.result); requestAnimationFrame(() => document.getElementById('topgear-result')?.scrollIntoView({ behavior: 'smooth' })) }
    } catch (err) { setError((err as Error).message) }
    finally { setRunning(false); setProgress(null) }
  }
  return <EquippedItems.Provider value={candidates.filter(c => c.source === 'equipped').map(c => itemId(c.itemString))}>
    <section className="pane topgear">
      <h2>Choose your gear</h2>
      <p className="note">Compare bag items and new gear against your equipped gear. Each entry is one copy.</p>
      <p className="warn banner">Equipment checks are provisional. Unique categories, embellishments, and some weapon eligibility rules still need verification. Review winning sets before equipping them.</p>
      <fieldset disabled={running} className="selection-controls">
        <legend className="sr-only">Candidate selection</legend>
        <button className="ghost" type="button" onClick={() => setSelected(new Set(candidates.filter((c) => c.source === 'equipped' || (c.supported && c.ilvl >= floor)).map((c) => c.id)))}>Select gear at {floor}+ ilvl</button>
        <button className="ghost" type="button" onClick={() => setSelected(new Set(candidates.filter((c) => c.source === 'equipped').map((c) => c.id)))}>Equipped only</button>
        <span>{selected.size} items selected</span>
      </fieldset>
      <div className="gear-filters">
        <button type="button" disabled={running} onClick={() => {
          const panel = document.getElementById('hypothetical-items') as HTMLDetailsElement | null
          if (panel) { panel.open = true; panel.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
        }}>Add new gear</button>
        <span className="note">Add a drop or crafted item that is not in the owned list.</span>
      </div>
      <nav className="slot-nav" aria-label="Equipment slots">{groups.map(([slot]) => <a key={slot} href={`#slot-${slot}`} onClick={() => { const el = document.getElementById(`slot-${slot}`); if (el) (el as HTMLDetailsElement).open = true }}>{label(slot)}</a>)}<a href="#hypothetical-items">New gear</a></nav>
      <div className="slot-groups">
        {groups.map(([slot, items]) => <details id={`slot-${slot}`} key={slot} className="slot-group" open>
          <summary>{label(slot)} <span>{items.filter((c) => selected.has(c.id)).length} / {items.length} selected</span></summary>
          <div className="slot-bulk"><button className="link" disabled={running} onClick={() => setSelected((previous) => new Set([...previous, ...items.filter((i) => i.supported).map((i) => i.id)]))}>Select visible</button><button className="link" disabled={running} onClick={() => setSelected((previous) => new Set([...previous].filter((id) => !items.some((i) => i.id === id && i.source !== 'equipped'))))}>Clear optional</button></div>
          <div className="candidate-grid">{items.map((item) => <label key={item.id} className={`candidate ${selected.has(item.id) ? 'selected' : ''}`}>
            <input type="checkbox" checked={selected.has(item.id)} disabled={running || item.source === 'equipped' || !item.supported}
              onChange={(e) => setSelected((previous) => { const next = new Set(previous); if (e.target.checked) next.add(item.id); else next.delete(item.id); return next })} />
            <ItemTooltip data={{
              name: item.name,
              ilvl: item.ilvl,
              slot: label(item.slot),
              itemString: item.itemString,
              statState: itemStats[item.statKey],
              notes: [
                item.source === 'equipped' ? 'Currently equipped'
                  : item.source === 'hypothetical' ? 'New gear' : 'In bags',
                ...(item.reason ? [item.reason] : [])
              ]
            }}>
              <span className="item-cell" tabIndex={0}><ItemIcon id={itemId(item.itemString)} /></span>
            </ItemTooltip>
            <span><strong>{item.name}</strong><small>{item.source === 'equipped' ? 'Equipped · always included' : item.reason ?? label(item.slot)}</small><small className="candidate-stats" aria-hidden="true">{statSummary(itemStats[item.statKey])}</small><details className="item-token-details" onClick={(e) => e.stopPropagation()}><summary>Item details</summary><code>{item.itemString}</code></details></span>
            <b>{item.ilvl}</b>
          </label>)}</div>
        </details>)}
      </div>
      <details id="hypothetical-items" className="hypothetical" open>
        <summary>New gear <span>{hypothetical.length} added</span></summary>
        <div className="picker-modes" role="group" aria-label="Item source">
          <button type="button" className={pickerMode === 'drop' ? 'active' : 'ghost'} disabled={running}
            onClick={() => { setPickerMode('drop'); setEditing(null) }}>Drops</button>
          <button type="button" className={pickerMode === 'crafted' ? 'active' : 'ghost'} disabled={running}
            onClick={() => { setPickerMode('crafted'); setEditing(null) }}>Crafted</button>
          <button type="button" className="ghost" disabled={running || loadingCatalyst}
            title="Adds each of your pieces as its tier version, which keeps that piece&apos;s item level and stats"
            onClick={() => void addCatalystOptions()}>{loadingCatalyst ? 'Reading your gear…' : 'Add catalyst versions'}</button>
        </div>
        {catalystNote ? <p className="note">{catalystNote}</p> : null}
        {pickerMode === 'crafted'
          ? <CraftedPicker raw={raw} disabled={running} editItem={editing === null ? undefined : hypothetical[editing]} onCancelEdit={() => setEditing(null)} onAdd={(item) => { setHypothetical((previous) => editing === null ? [...previous, item] : previous.map((h, i) => i === editing ? item : h)); setEditing(null) }} />
          : <ItemPicker raw={raw} disabled={running} editItem={editing === null ? undefined : hypothetical[editing]} onCancelEdit={() => setEditing(null)} onAdd={(item) => { setHypothetical((previous) => editing === null ? [...previous, item] : previous.map((h, i) => i === editing ? item : h)); setEditing(null) }} />}
        {hypothetical.length > 0 ? (
          <ul className="hypothetical-list">
            {hypothetical.map((h, i) => (
              <li key={`${h.itemString}-${i}`}>
                <ItemIcon id={itemId(h.itemString)} tooltip={{ name: h.label?.trim() || h.itemString, itemString: h.itemString, ilvl: h.selection?.ilvl }} />
                <span className="hyp-name">{h.label?.trim() || h.itemString}</span>
                {h.selection ? <span className="tag">{selectionIlvl(h.selection)} ilvl · {h.selection.kind === 'crafted' ? 'crafted' : 'new'}</span> : null}
                {h.embellished ? <span className="tag loadouts">embellished</span> : null}
                <code>{h.itemString}</code>
                {h.selection ? <button className="link" disabled={running} onClick={() => { setPickerMode(h.selection?.kind === 'crafted' ? 'crafted' : 'drop'); setEditing(i); document.getElementById('hypothetical-items')?.scrollIntoView({ behavior: 'smooth' }) }}>Edit</button> : null}
                <button className="link danger" disabled={running}
                  onClick={() => { setHypothetical((prev) => prev.filter((_, j) => j !== i)); setEditing(null) }}>Remove</button>
              </li>
            ))}
          </ul>
        ) : null}
        <details className="advanced-import"><summary>Advanced: import an exact SimC item</summary><p className="note">For crafted or unsupported variants. A custom ilevel override does not establish an obtainable upgrade track.</p><div className="hypothetical-add">
          <label>Item string
            <input value={draft} disabled={running} spellCheck={false}
              placeholder="trinket1=,id=250214,bonus_id=6652,ilevel=350"
              onChange={(e) => setDraft(e.target.value)} />
          </label>
          <label>Name (optional)
            <input value={draftLabel} disabled={running} placeholder="Crafted ring"
              onChange={(e) => setDraftLabel(e.target.value)} />
          </label>
          <label title="Use Unknown unless the exact item is known to be plain or embellished.">Embellishment
            <select value={draftEmbellished === undefined ? 'unknown' : draftEmbellished ? 'yes' : 'no'} disabled={running}
              onChange={(e) => setDraftEmbellished(e.target.value === 'unknown' ? undefined : e.target.value === 'yes')}>
              <option value="unknown">Unknown</option><option value="yes">Yes</option><option value="no">No</option>
            </select>
          </label>
          <button className="ghost" disabled={running || draft.trim() === ''}
            onClick={() => {
              setHypothetical((prev) => [...prev, { itemString: draft.trim(), label: draftLabel.trim() || undefined, ...(draftEmbellished === undefined ? {} : { embellished: draftEmbellished }) }])
              setDraft(''); setDraftLabel(''); setDraftEmbellished(undefined)
            }}>Add item</button>
        </div></details>
      </details>

      <details className="advanced-import"><summary>Advanced simulation settings</summary><fieldset className="sim-settings" disabled={running}>
        <legend>Simulation settings</legend>
        <label>CPU threads<input type="number" min={1} max={logicalThreads} value={threads} onChange={(e) => setThreads(Number(e.target.value))} /></label>
        <label>Targets<input type="number" min={1} max={20} value={targets} onChange={(e) => setTargets(Number(e.target.value))} /></label>
      </fieldset></details>
      <p className="note">Every fight is Patchwerk: targets stand still and take damage for the whole fight, with no movement, adds or phases. <strong>Fight length</strong> is how long each simulated pull lasts. <strong>Search time</strong> is how long SimItBoi spends looking for better gear — it is a target, not a limit, because preparation and final verification always finish.</p>
      <div className="actions run-bar"><span>{selected.size} owned + {hypothetical.length} new</span><label>Fight length<select disabled={running} value={fightSeconds} onChange={(e) => setFightSeconds(Number(e.target.value))}>{fightLengthOptions(fightSeconds).map((preset) => <option key={preset.seconds} value={preset.seconds}>{preset.label}</option>)}</select></label><label>Search time<select disabled={running} value={budget} onChange={(e) => setBudget(Number(e.target.value))}>{SEARCH_TIMES.map((preset) => <option key={preset.seconds} value={preset.seconds}>{preset.label}</option>)}</select></label><button disabled={running} onClick={() => void run()}>{running ? 'Simulating…' : 'Find top gear'}</button>
        {running ? <button className="ghost" onClick={() => void api.cancelSim()}>Cancel</button> : null}</div>
      {progress ? <div className="topgear-progress" role="status" aria-live="polite">
        <strong>{progress.stage}</strong><span>{progress.detail}</span>
        <progress max={1} value={progress.fraction} aria-label={progress.stage} />
      </div> : null}
      {error ? <p className="err" role="alert">{error}</p> : null}
    </section>
    {result ? <div id="topgear-result"><p className="note">Last completed run. Changes to the selection apply to the next simulation.</p><TopGearResultView result={result} /></div> : null}
  </EquippedItems.Provider>
}

/**
 * Renders a finished Top Gear result. Extracted from the runner so saved
 * reports can be re-rendered from history without re-running anything.
 */
export function TopGearResultView({ result }: { result: TopGearResult }): JSX.Element {
  const [detailId, setDetailId] = useState<string>('baseline')
  const accepted = result.hypotheticalAccepted ?? []
  const rejected = result.hypotheticalRejected ?? []
  const active = result.ranking.find((r) => r.id === detailId)
  return <section className="pane">
      <h2>Top Gear comparison</h2>
      <p>Simulated <strong>{fmt(result.stageOneSimulated)}</strong> shortlisted {result.stageOneSimulated === 1 ? 'set' : 'sets'} from <strong>{BigInt(result.combinationCount).toLocaleString()}</strong> {result.combinationCount === '1' ? 'combination' : 'combinations'} under available equipment checks.</p>
      <p className="note">{result.detailedSimulated} detailed reruns · {(result.durationMs / 1000).toFixed(1)}s elapsed · {result.settings.threads} threads · simc {result.version.build} · item data {result.metadata.generated.slice(0, 10)}</p>
      <p className="note">Small differences inside the error ranges may be simulation noise. This shortlist search does not guarantee the best possible set.</p>
      {result.warnings.length ? <ul className="warn">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
      <div className="table-scroll"><table className="comparison"><thead><tr><th>Set</th><th>DPS</th><th>Change</th><th>Gear changes</th><th>Report</th></tr></thead><tbody>
        <tr><th>Equipped</th><td>{fmt(result.baseline.dps.mean)} ± {fmt(result.baseline.dps.error)}</td><td>Baseline</td><td>Current gear</td><td><button className="ghost" onClick={() => setDetailId('baseline')}>View</button></td></tr>
        {result.ranking.map((row, index) => <tr key={row.id} className={detailId === row.id ? 'active-result' : ''}>
          <th>#{index + 1}</th><td>{fmt(row.dps)} ± {fmt(row.error)}</td><td className={row.delta > 0 ? 'gain' : ''}>{row.delta > 0 ? '+' : ''}{fmt(row.delta)} ({row.deltaPct.toFixed(2)}%)</td>
          <td>{row.changes.length ? <details><summary>{row.changes.length} slot changes</summary><ul>{row.changes.map((change) => <li key={change.slot}><b>{label(change.slot)}</b>: <ItemTooltip data={{ name: change.before, itemString: change.beforeItem ?? undefined, slot: label(change.slot) }}><span>{change.before}</span></ItemTooltip> → <ItemTooltip data={{ name: change.after, itemString: change.afterItem ?? undefined, slot: label(change.slot) }}><span className="item-cell"><ItemIcon id={itemId(change.afterItem ?? '')} />{change.after}</span></ItemTooltip></li>)}</ul></details> : 'Same gear'}</td>
          <td><button className="ghost" onClick={() => setDetailId(row.id)}>View</button></td>
        </tr>)}
      </tbody></table></div>
      {accepted.length || rejected.length ? (
        <details className="run-details" open={rejected.length > 0}>
          <summary>New gear ({accepted.length} used{rejected.length ? `, ${rejected.length} rejected` : ''})</summary>
          <ul>
            {accepted.map((h, i) => (
              <li key={`${h.itemString}-${i}`}><strong>{h.name}</strong> [{label(h.slot)}]{h.ilvl ? ` · ${h.ilvl} ilvl` : ''}{h.embellished ? ' · embellished' : ''} — <code>{h.itemString}</code></li>
            ))}
            {rejected.map((h, i) => (
              <li key={`${h.itemString}-${i}`} className="warn"><strong>Rejected</strong> <code>{h.itemString}</code> — {h.reason}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {result.rejected.length ? <details className="run-details"><summary>Excluded choices ({result.rejected.length})</summary><ul>{result.rejected.map((r, i) => <li key={i}><strong>{r.description}</strong>: {r.reason}</li>)}</ul></details> : null}
      <details className="run-details"><summary>Reproduce this run</summary><p className="note">Fight length {result.settings.fightSeconds}s (Patchwerk); search time {result.settings.budgetSeconds}s; targets {result.settings.targets}; item table v{result.metadata.version}; accuracy {result.settings.looseError}% / {result.settings.tightError}%.</p>
        <p className="note">simc binary SHA-256: {result.binarySha256}</p>
        <label>Winning gear overrides<textarea readOnly value={result.ranking[0]?.overrides.join('\n') ?? ''} /></label>
      </details>
      <h3>{active ? `Detailed report · ${fmt(active.dps)} DPS` : 'Equipped gear report'}</h3>
      <Report report={active?.report ?? result.baseline} durationMs={active?.durationMs ?? result.baselineDurationMs} simcVersion={result.version.build} versionWarning={null} />
    </section>
}
