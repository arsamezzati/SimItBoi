import { useCallback, useEffect, useRef, useState } from 'react'
import type { SimReport } from '../../core/report/extract.ts'
import Report from './Report.tsx'
import TopGear from './TopGear.tsx'
import History from './History.tsx'
import SimcBuilds from './SimcBuilds.tsx'
import Loadouts from './Loadouts.tsx'
import { ItemPreviewProfile } from './ItemTooltip.tsx'
import type { CandidateOption, TopGearResult } from '../../core/topgear/funnel.ts'
import type { SimItBoiApi } from '../../core/api.ts'
import { ArmoryImport } from './ArmoryImport.tsx'
import { CharacterCard } from './CharacterCard.tsx'

interface ParsedProfile {
  characterName: string
  className: string
  spec?: string
  level?: number
  race?: string
  itemLevel: number | null
  header: { region?: string; realm?: string; addonVersion?: string; wowBuild?: string; requiresSimcBuild?: string }
  checksum?: string
  savedLoadouts: string[]
  equippedCount: number
  bagCount: number
  extraLines: string[]
  coverage: { stale: boolean; reason?: string; unknown: number[]; generated: string; items: number }
  warnings: string[]
  candidates: CandidateOption[]
}

interface Progress {
  phase: string
  completed: number
  total: number
  throughput: number
  fraction: number
}

interface SimResult {
  report: SimReport
  durationMs: number
  simcVersion: string | null
  versionWarning: string | null
}

const api = (window as unknown as { simitboi: SimItBoiApi }).simitboi

async function readSimcVersion(): Promise<string> {
  const r = await api.simcVersion()
  return r.ok && r.version ? `${r.version.build} (WoW ${r.version.wowBuild})` : `not found — ${r.ok ? 'unknown build' : r.error}`
}

export default function App(): JSX.Element {
  const [env, setEnv] = useState<Record<string, unknown> | null>(null)
  const [simcVersion, setSimcVersion] = useState<string>('checking…')
  const [showSimc, setShowSimc] = useState(false)
  const [simcUpdate, setSimcUpdate] = useState<string | null>(null)
  const [raw, setRaw] = useState('')
  const [profile, setProfile] = useState<ParsedProfile | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [result, setResult] = useState<SimResult | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [mode, setMode] = useState<'quick' | 'topgear' | 'loadouts' | 'history'>('quick')
  /** Bumped after every completed run so History reloads its list. */
  const [historyKey, setHistoryKey] = useState(0)
  const [restoreGear, setRestoreGear] = useState<TopGearResult | null>(null)
  const [importOpen, setImportOpen] = useState(true)
  const [importMethod, setImportMethod] = useState<'addon' | 'armory'>(() => {
    try { return localStorage.getItem('import-method') === 'armory' ? 'armory' : 'addon' } catch { return 'addon' }
  })
  function chooseImport(method: 'addon' | 'armory'): void {
    setImportMethod(method)
    try { localStorage.setItem('import-method', method) } catch { /* only a convenience */ }
  }

  const loadSavedProfile = useCallback((saved: string, scenario?: TopGearResult) => {
    setRaw(saved)
    setMode(scenario ? 'topgear' : 'quick')
    setRestoreGear(scenario ?? null)
    void handleParse(saved)
  }, [])
  const parseSequence = useRef(0)

  /** Re-read after a build switch, which changes what the header should say. */
  async function refreshSimc(): Promise<void> {
    setSimcVersion('checking…')
    setSimcVersion(await readSimcVersion())
    setEnv(await api.envInfo())
  }

  useEffect(() => {
    // Provisioning the bundled simulator runs in the background on first
    // launch, so one fetch would leave the header saying 'preparing' forever.
    // Polling stops as soon as the state settles either way.
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const readEnv = (): void => {
      void api.envInfo().then((info) => {
        if (cancelled) return
        setEnv(info)
        if (info.simcState === 'provisioning') { timer = setTimeout(readEnv, 1000); return }
        // Once the simulator is settled, ask whether a newer approved one exists.
        void api.checkSimcUpdate().then((r) => {
          if (!cancelled) setSimcUpdate(r.ok && r.check.status === 'available' ? r.check.build.version : null)
        })
      })
    }
    readEnv()
    void readSimcVersion().then(setSimcVersion)
    const stopProgress = api.onProgress(setProgress)
    return () => { cancelled = true; clearTimeout(timer); stopProgress() }
  }, [])

  async function handleParse(text: string): Promise<void> {
    const sequence = ++parseSequence.current
    setRaw(text)
    setProfile(null)
    setResult(null)
    setRunError(null)
    if (text.trim() === '') {
      setProfile(null)
      setParseError(null)
      return
    }
    const r = await api.parseProfile(text)
    if (sequence !== parseSequence.current) return
    if (r.ok) {
      setProfile(r.profile)
      setImportOpen(false)
      setParseError(null)
    } else {
      setProfile(null)
      setParseError(r.error)
    }
  }

  async function handleRun(): Promise<void> {
    setRunning(true)
    // The previous report stays up until a new one replaces it, matching Top
    // Gear: a cancelled or failed rerun should not cost you the result you had.
    setRunError(null)
    setProgress(null)
    try {
      const r = await api.runSim(raw, { iterations: 1000 })
      if (r.ok) setResult(r)
      else setRunError(r.error)
    } catch (err) { setRunError((err as Error).message) }
    finally { setRunning(false); setProgress(null); setHistoryKey((k) => k + 1) }
  }

  return (
    <ItemPreviewProfile.Provider value={raw}><div className="app">
      <header>
        <h1 className="brand"><img src="icon.png" alt="" width={28} height={28} /><span>SimIt<em>Boi</em></span></h1>
        <div className="meta">
          <button type="button" className="link meta-link" aria-expanded={showSimc}
            onClick={() => setShowSimc((open) => !open)}>simc {simcVersion}</button>
          {/* Unzipping a new release over an old folder now switches simulators;
              say so, since it changes the numbers a rerun produces. */}
          {env?.simcUpgradedFrom ? <span className="warn-inline" title={'Previous build: ' + String(env.simcUpgradedFrom)}>simulator updated</span> : null}
          {simcUpdate && !showSimc ? (
            <button type="button" className="link meta-link update-badge" onClick={() => setShowSimc(true)}>
              simc {simcUpdate} available
            </button>
          ) : null}
          {/* First launch installs the bundled simulator, which takes a moment.
              Saying so beats looking broken, and a failure names itself rather
              than leaving an empty version. */}
          {env?.simcState === 'provisioning' ? <span>preparing simulator…</span> : null}
          {env?.simcState === 'failed' ? <span className="err" title={String(env.simcProblem)}>simulator unavailable</span> : null}
          {env ? <span title={String(env.dataDir)}>{env.portable ? 'portable' : 'dev'} data</span> : null}
          {/* A silent fallback is a miserable bug to diagnose: the user needs to
              know their data is not beside the executable any more. */}
          {env?.fellBack ? <span className="warn-inline" title={String(env.dataDirReason)}>data moved to {String(env.dataDir)}</span> : null}
        </div>
      </header>

      {showSimc ? <SimcBuilds running={running} onChanged={() => void refreshSimc()} onBusyChange={setRunning} /> : null}

      {/* The snapshot check used to log its problems and let everything carry
          on regardless. A user whose data is damaged now sees why nothing
          works, and what to do, instead of a string of unexplained failures. */}
      {Array.isArray(env?.dataProblems) && env.dataProblems.length > 0 ? (
        <section className="pane data-problems" role="alert">
          <h2>SimItBoi cannot use its bundled data</h2>
          <p className="note">
            Simulating and configuring gear are disabled, because results built on this data
            would not mean anything. Re-installing SimItBoi over this folder replaces the data
            files and keeps your history, which lives in <code>simitboi.db</code>.
          </p>
          <ul className="warn">
            {(env.dataProblems as Array<{ file: string; problem: string }>).map((p) => (
              <li key={p.file + p.problem}><strong>{p.file}</strong> — {p.problem}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="pane import-pane" open={importOpen} onToggle={(e) => setImportOpen(e.currentTarget.open)}>
        <summary>{profile ? `${profile.characterName} imported · change profile` : 'Import your character'}</summary>
        <nav className="mode-tabs import-tabs" aria-label="Import method">
          <button type="button" aria-pressed={importMethod === 'addon'} disabled={running} onClick={() => chooseImport('addon')}>SimC addon string</button>
          <button type="button" aria-pressed={importMethod === 'armory'} disabled={running} onClick={() => chooseImport('armory')}>Armory</button>
        </nav>
        {importMethod === 'armory' ? (
          <ArmoryImport disabled={running} onImported={(text) => { setRestoreGear(null); void handleParse(text) }} />
        ) : (
          <>
            <label htmlFor="paste">Paste your SimC addon string</label>
            <textarea
              id="paste"
              spellCheck={false}
              placeholder="/simc in game, then paste the whole export here…"
              value={raw}
              disabled={running}
              onChange={(e) => { setRestoreGear(null); void handleParse(e.target.value) }}
            />
          </>
        )}
        {parseError ? <p className="err">{parseError}</p> : null}
      </details>

      {profile ? (
        <section className="pane">
          <CharacterCard profile={profile} />
          <details><summary>Character details · {profile.equippedCount} equipped · {profile.bagCount} bag items</summary><div className="grid">
            <Stat label="Equipped" value={profile.equippedCount} />
            <Stat label="Bag candidates" value={profile.bagCount} />
            <Stat label="Saved loadouts" value={profile.savedLoadouts.length} />
            <Stat label="Addon" value={profile.header.addonVersion ?? '—'} />
            <Stat label="WoW build" value={profile.header.wowBuild ?? '—'} />
            <Stat label="Requires simc" value={profile.header.requiresSimcBuild ?? '—'} />
          </div></details>
          {profile.extraLines.length > 0 ? (
            <p className="note">Passed through verbatim: {profile.extraLines.join(', ')}</p>
          ) : null}
          {profile.coverage.stale ? (
            <p className="warn banner">{profile.coverage.reason}</p>
          ) : null}

          {profile.warnings.length > 0 ? (
            <ul className="warn">
              {profile.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}

          <nav className="mode-tabs" aria-label="Simulation type">
            <button className={mode === 'quick' ? '' : 'ghost'} disabled={running} aria-pressed={mode === 'quick'} onClick={() => setMode('quick')}>Quick Sim</button>
            <button className={mode === 'topgear' ? '' : 'ghost'} disabled={running} aria-pressed={mode === 'topgear'} onClick={() => setMode('topgear')}>Top Gear</button>
            <button className={mode === 'loadouts' ? '' : 'ghost'} disabled={running} aria-pressed={mode === 'loadouts'} onClick={() => setMode('loadouts')}>Loadouts</button>
            <button className={mode === 'history' ? '' : 'ghost'} disabled={running} aria-pressed={mode === 'history'} onClick={() => setMode('history')}>History</button>
          </nav>
          <div className="actions" hidden={mode !== 'quick'}>
            <button onClick={() => void handleRun()} disabled={running}>
              {running ? 'Simulating…' : 'Run quick sim'}
            </button>
            {running ? <button className="ghost" onClick={() => void api.cancelSim()}>Cancel</button> : null}
          </div>

          {progress && mode === 'quick' ? (
            <div className="progress">
              <div className="bar">
                <div className="fill" style={{ transform: `scaleX(${progress.fraction})` }} />
              </div>
              <span>
                {progress.phase} · {progress.completed}/{progress.total}
              </span>
            </div>
          ) : null}

          {runError && mode === 'quick' ? <p className="err">{runError}</p> : null}

        </section>
      ) : null}

      {profile ? <div hidden={mode !== 'topgear'}><TopGear raw={raw} candidates={profile.candidates} restored={restoreGear} running={running} setRunning={(v) => { setRunning(v); if (!v) setHistoryKey((k) => k + 1) }} logicalThreads={Number(env?.logicalThreads ?? 1)} /></div> : null}

      {profile ? (
        <div hidden={mode !== 'loadouts'}>
          <Loadouts raw={raw} savedCount={profile.savedLoadouts.length} running={running}
            setRunning={(v) => { setRunning(v); if (!v) setHistoryKey((k) => k + 1) }}
            logicalThreads={Number(env?.logicalThreads ?? 1)} />
        </div>
      ) : null}

      {mode === 'history' ? (
        <section className="pane">
          <History refreshKey={historyKey} onLoadProfile={loadSavedProfile} />
        </section>
      ) : null}

      {result && mode === 'quick' ? (
        <section className="pane">
          <Report
            report={result.report}
            durationMs={result.durationMs}
            simcVersion={result.simcVersion}
            versionWarning={result.versionWarning}
          />
        </section>
      ) : null}
    </div></ItemPreviewProfile.Provider>
  )
}

function Stat({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="stat">
      <span className="k">{label}</span>
      <span className="v">{value}</span>
    </div>
  )
}
