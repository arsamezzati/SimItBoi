import { useCallback, useEffect, useState } from 'react'
import type { SimItBoiApi } from '../../core/api.ts'
import type { ReportRow } from '../../core/store/db.ts'
import type { SimReport } from '../../core/report/extract.ts'
import type { TopGearResult } from '../../core/topgear/funnel.ts'
import Report from './Report.tsx'
import { TopGearResultView } from './TopGear.tsx'
import { LoadoutComparisonView } from './Loadouts.tsx'
import type { LoadoutComparison } from '../../core/topgear/loadouts.ts'
import { storedRunInput, unwrapRunPayload } from '../../core/runEnvelope.ts'

const api = (window as unknown as { simitboi: SimItBoiApi }).simitboi

const fmt = (n: number | null): string => (n === null ? '—' : Math.round(n).toLocaleString())

/**
 * The store keeps the newest 200 reports. This asked for 50 and offered no way
 * to see the rest, so three quarters of retained history were unreachable.
 */
const PAGE_SIZE = 50

function when(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

export default function History({
  refreshKey,
  onLoadProfile
}: {
  /** Bumped by the parent after a run so the list picks up the new report. */
  refreshKey: number
  onLoadProfile: (raw: string, scenario?: TopGearResult) => void
}): JSX.Element {
  const [rows, setRows] = useState<ReportRow[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [openPayload, setOpenPayload] = useState<unknown>(null)
  const [openRow, setOpenRow] = useState<ReportRow | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const refresh = useCallback(async () => {
    const r = await api.listHistory({ limit: PAGE_SIZE })
    if (r.ok) {
      setRows(r.reports)
      setTotal(r.total)
      setError(null)
    } else {
      setError(r.error)
    }
  }, [])

  /** Appends the next page, so the open report and scroll position survive. */
  const loadMore = useCallback(async () => {
    setLoadingMore(true)
    const r = await api.listHistory({ limit: PAGE_SIZE, offset: rows.length })
    setLoadingMore(false)
    if (!r.ok) { setError(r.error); return }
    setError(null)
    setTotal(r.total)
    // Guard against a report being saved between pages, which would otherwise
    // shift the offset and duplicate a row.
    setRows((previous) => {
      const seen = new Set(previous.map((row) => row.id))
      return [...previous, ...r.reports.filter((row) => !seen.has(row.id))]
    })
  }, [rows.length])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  async function open(id: string): Promise<void> {
    if (openId === id) {
      setOpenId(null)
      setOpenPayload(null)
      setOpenRow(null)
      return
    }
    setLoading(true)
    const r = await api.getHistory(id)
    setLoading(false)
    if (r.ok) {
      setOpenId(id)
      setOpenRow(r.row)
      setOpenPayload(r.payload)
      setError(null)
    } else {
      setError(r.error)
    }
  }

  async function remove(id: string): Promise<void> {
    const r = await api.deleteHistory(id)
    if (r.ok) {
      if (openId === id) {
        setOpenId(null)
        setOpenPayload(null)
        setOpenRow(null)
      }
      await refresh()
    } else {
      setError(r.error)
    }
  }

  async function restore(id: string, checksum: string | null, scenario: boolean): Promise<void> {
    const response = await api.getHistory(id)
    if (!response.ok) { setError(response.error); return }
    const input = storedRunInput(response.payload)
    if (input) {
      onLoadProfile(input, scenario ? unwrapRunPayload<TopGearResult>(response.payload) : undefined)
      return
    }
    if (!checksum) { setError('This legacy report did not store its input profile.'); return }
    const profile = await api.getProfile(checksum)
    if (profile.ok) onLoadProfile(profile.raw, scenario ? unwrapRunPayload<TopGearResult>(response.payload) : undefined)
    else setError(profile.error)
  }

  if (error) return <p className="err">{error}</p>

  if (rows.length === 0) {
    return (
      <p className="note">
        No saved reports yet. Quick Sim and Top Gear results are stored automatically and survive
        restarts.
      </p>
    )
  }

  return (
    <div className="history">
      <h3>
        History <small>showing {rows.length} of {total} · newest 200 kept</small>
      </h3>
      <table className="history-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={openId === r.id ? 'open' : undefined}>
              <td className="kind">
                <span className={`tag ${r.kind}`}>{r.kind === 'quick' ? 'Quick' : r.kind === 'loadouts' ? 'Loadouts' : 'Top Gear'}</span>
              </td>
              <td className="who">
                {r.characterName ?? 'Unknown'}
                {r.spec ? <span className="dim"> {r.spec}</span> : null}
              </td>
              <td className="num">{fmt(r.dps)}</td>
              <td className="num dim">
                {r.delta !== null && r.delta !== 0
                  ? `${r.delta > 0 ? '+' : ''}${Math.round(r.delta).toLocaleString()}`
                  : ''}
              </td>
              <td className="num dim">{when(r.createdAt)}</td>
              <td className="num dim">{r.simcBuild ?? ''}</td>
              <td className="row-actions">
                <button className="link" onClick={() => void open(r.id)}>
                  {openId === r.id ? 'Hide' : 'View'}
                </button>
                <button className="link" onClick={() => void restore(r.id, r.profileChecksum, r.kind === 'topgear')}>
                    {r.kind === 'topgear' ? 'Restore selection' : 'Load'}
                </button>
                <button className="link danger" onClick={() => void remove(r.id)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {rows.length < total ? (
        <button type="button" className="ghost history-more" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? 'Loading…' : `Show ${Math.min(PAGE_SIZE, total - rows.length)} older`}
        </button>
      ) : null}

      {loading ? <p className="note">Loading report…</p> : null}

      {openId && openRow && openPayload ? (
        <div className="history-detail">
          {openRow.kind === 'quick' ? (
            <Report
              report={unwrapRunPayload<SimReport>(openPayload)}
              durationMs={openRow.durationMs ?? 0}
              simcVersion={openRow.simcBuild}
              versionWarning={null}
            />
          ) : openRow.kind === 'loadouts' ? (
            <LoadoutComparisonView comparison={unwrapRunPayload<LoadoutComparison>(openPayload)} />
          ) : (
            <TopGearResultView result={unwrapRunPayload<TopGearResult>(openPayload)} />
          )}
        </div>
      ) : null}
    </div>
  )
}
