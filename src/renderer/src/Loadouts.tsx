import { useEffect, useState } from 'react'
import type { SimItBoiApi } from '../../core/api.ts'
import type { LoadoutComparison } from '../../core/topgear/loadouts.ts'
import type { SimProgress } from '../../core/simc/runner.ts'
import { DEFAULT_FIGHT_SECONDS, fightLengthOptions } from './simPresets.ts'

const api = (window as unknown as { simitboi: SimItBoiApi }).simitboi
const fmt = (n: number): string => Math.round(n).toLocaleString()

export function LoadoutComparisonView({ comparison }: { comparison: LoadoutComparison }): JSX.Element {
  const { results, baselineDps, baselineError, skipped } = comparison
  const best = results[0]
  const worthSwitching = best && !best.isCurrent && !best.withinNoise

  return (
    <>
      <h2>Talent loadouts</h2>
      <p className="note">
        Current talents: <strong>{fmt(baselineDps)}</strong> ± {fmt(baselineError)} DPS ·{' '}
        {results.length} distinct {results.length === 1 ? 'build' : 'builds'} ·{' '}
        {(comparison.durationMs / 1000).toFixed(1)}s
      </p>

      {worthSwitching ? (
        <p className="banner-good">
          <strong>{best.names.join(', ')}</strong> is {fmt(best.delta)} DPS ahead (
          {best.deltaPct > 0 ? '+' : ''}
          {best.deltaPct.toFixed(2)}%) — beyond the error bars.
        </p>
      ) : (
        <p className="note">
          No saved loadout beats the current talents by more than simulation noise.
        </p>
      )}

      <div className="table-scroll">
        <table className="comparison">
          <thead>
            <tr>
              <th>Loadout</th>
              <th>DPS</th>
              <th>Change</th>
              <th>Talent string</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.talents} className={r.isCurrent ? 'active-result' : undefined}>
                <th>
                  {r.names.join(', ')}
                  {r.isCurrent ? <span className="tag quick">current</span> : null}
                </th>
                <td>
                  {fmt(r.dps)} ± {fmt(r.error)}
                </td>
                <td className={!r.isCurrent && r.delta > 0 && !r.withinNoise ? 'gain' : undefined}>
                  {r.isCurrent ? (
                    'Baseline'
                  ) : (
                    <>
                      {r.delta > 0 ? '+' : ''}
                      {fmt(r.delta)} ({r.delta > 0 ? '+' : ''}
                      {r.deltaPct.toFixed(2)}%)
                      {r.withinNoise ? <span className="dim"> · within noise</span> : null}
                    </>
                  )}
                </td>
                <td>
                  <input className="talent-string" readOnly value={r.talents} onFocus={(e) => e.currentTarget.select()} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {skipped.length > 0 ? (
        <details className="run-details">
          <summary>Skipped ({skipped.length})</summary>
          <ul>
            {skipped.map((s) => (
              <li key={s.name}>
                <strong>{s.name}</strong>: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="note">
        Loadouts saved under several names are simmed once and listed together. Differences inside
        the error bars are simulation noise, not upgrades.
      </p>
    </>
  )
}

export default function Loadouts({
  raw,
  savedCount,
  running,
  setRunning,
  logicalThreads
}: {
  raw: string
  savedCount: number
  running: boolean
  setRunning: (value: boolean) => void
  logicalThreads: number
}): JSX.Element {
  const [threads, setThreads] = useState(Math.max(1, logicalThreads - 2))
  const [fightSeconds, setFightSeconds] = useState(DEFAULT_FIGHT_SECONDS)
  const [progress, setProgress] = useState<SimProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [comparison, setComparison] = useState<LoadoutComparison | null>(null)

  useEffect(() => api.onProgress(setProgress), [])

  async function run(): Promise<void> {
    setRunning(true)
    setError(null)
    setComparison(null)
    setProgress(null)
    try {
      const r = await api.runLoadouts(raw, { threads, fightSeconds })
      if (r.ok) setComparison(r.comparison)
      else setError(r.error)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
      setProgress(null)
    }
  }

  return (
    <>
      <section className="pane">
        <h2>Compare talent loadouts</h2>
        <p className="note">
          {savedCount === 0
            ? 'This export contains no saved loadouts. Save some in game and re-export.'
            : `${savedCount} saved ${savedCount === 1 ? 'loadout' : 'loadouts'} found in your export. Identical builds are simmed once.`}
        </p>
        <fieldset className="sim-settings" disabled={running}>
          <legend>Simulation settings</legend>
          <label>
            CPU threads
            <input type="number" min={1} max={logicalThreads} value={threads}
              onChange={(e) => setThreads(Number(e.target.value))} />
          </label>
          <label>
            Fight length
            <select value={fightSeconds} onChange={(e) => setFightSeconds(Number(e.target.value))}>
              {fightLengthOptions(fightSeconds).map((preset) =>
                <option key={preset.seconds} value={preset.seconds}>{preset.label}</option>)}
            </select>
          </label>
        </fieldset>
        <div className="actions">
          <button onClick={() => void run()} disabled={running || savedCount === 0}>
            {running ? 'Simulating…' : 'Compare loadouts'}
          </button>
          {running ? (
            <button className="ghost" onClick={() => void api.cancelSim()}>
              Cancel
            </button>
          ) : null}
        </div>
        {progress ? (
          <div className="progress">
            <div className="bar">
              <div className="fill" style={{ transform: `scaleX(${progress.fraction})` }} />
            </div>
            <span>
              {progress.phase} · {progress.completed}/{progress.total}
            </span>
          </div>
        ) : null}
        {error ? <p className="err" role="alert">{error}</p> : null}
      </section>

      {comparison ? (
        <section className="pane">
          <LoadoutComparisonView comparison={comparison} />
        </section>
      ) : null}
    </>
  )
}
