import { useCallback, useEffect, useState } from 'react'
import type { SimItBoiApi, SimcBuildSummary } from '../../core/api.ts'
import type { UpdateCheck, UpdateProgress } from '../../core/simc/update.ts'

const api = (window as unknown as { simitboi: SimItBoiApi }).simitboi

/**
 * Installed simulator builds, and switching between them.
 *
 * Activation and rollback existed in the main process with nothing calling
 * them, so a user whose simulator broke — or who wanted the previous build back
 * after an upgrade — had no way to act on it short of deleting files by hand.
 */
export default function SimcBuilds({
  running,
  onChanged,
  onBusyChange
}: {
  /** Switching is refused mid-run: that run already pinned its binary. */
  running: boolean
  /** Called after a switch, so the header re-reads the active version. */
  onChanged: () => void
  /** An install blocks simulations, so the app disables its run buttons meanwhile. */
  onBusyChange: (busy: boolean) => void
}): JSX.Element {
  const [builds, setBuilds] = useState<SimcBuildSummary[] | null>(null)
  const [previousBuildId, setPreviousBuildId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [update, setUpdate] = useState<UpdateCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState<UpdateProgress | null>(null)

  const check = useCallback(async (force: boolean) => {
    setChecking(true)
    const r = await api.checkSimcUpdate(force)
    setChecking(false)
    setUpdate(r.ok ? r.check : { status: 'unreachable', error: r.error })
  }, [])

  useEffect(() => { void check(false) }, [check])
  useEffect(() => api.onSimcUpdateProgress(setInstalling), [])

  async function install(): Promise<void> {
    setMessage(null)
    setError(null)
    setInstalling({ stage: 'downloading', fraction: 0 })
    onBusyChange(true)
    const r = await api.installSimcUpdate()
    onBusyChange(false)
    setInstalling(null)
    if (!r.ok) setError(r.error)
    else if (r.result.status === 'installed') {
      setMessage('Now using ' + r.result.manifest.buildId + '. The previous build is kept if you need to roll back.')
      onChanged()
    } else {
      setError('The new simulator was not kept: ' + r.result.reason + '. Your previous build is still in use.')
    }
    setUpdate({ status: 'current' })
    await load()
  }

  const STAGE_TEXT: Record<UpdateProgress['stage'], string> = {
    downloading: 'Downloading',
    verifying: 'Verifying checksum',
    installing: 'Installing',
    testing: 'Testing the new simulator',
    'rolling back': 'Restoring previous build'
  }

  const load = useCallback(async () => {
    const r = await api.simcBuilds()
    if (r.ok) {
      setBuilds(r.builds)
      setPreviousBuildId(r.previousBuildId)
      setError(r.problem)
    } else {
      setError(r.error)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function act(work: () => ReturnType<SimItBoiApi['rollbackSimcBuild']>, done: string): Promise<void> {
    setBusy(true)
    setMessage(null)
    setError(null)
    const r = await work()
    setBusy(false)
    if (r.ok) {
      setMessage(done + ' ' + r.buildId + '.')
      onChanged()
    } else {
      setError(r.error)
    }
    await load()
  }

  const describe = (build: SimcBuildSummary): string =>
    (build.version ?? 'unknown version') + ' · ' +
    (build.source === 'bundled' ? 'shipped with SimItBoi' : 'from ' + build.source) + ' · installed ' +
    new Date(build.provisionedAt).toLocaleDateString()

  const previous = builds?.find((b) => b.buildId === previousBuildId && b.problems.length === 0)

  return (
    <section className="pane simc-builds" aria-label="Simulator builds">
      <h2>Simulator</h2>
      <p className="note">
        SimItBoi runs its own copy of SimulationCraft. A new SimItBoi release brings a newer one and
        switches to it automatically; the build it replaced stays installed so you can go back.
      </p>

      <div className="simc-update" aria-label="Simulator updates">
        {installing ? (
          <div role="status">
            <strong>{STAGE_TEXT[installing.stage]}…</strong>
            {installing.fraction !== undefined
              ? <progress max={1} value={installing.fraction} aria-label="Download progress" />
              : <progress aria-label={STAGE_TEXT[installing.stage]} />}
          </div>
        ) : update?.status === 'available' ? (
          <div className="update-offer">
            <div>
              <strong>simc {update.build.version} is available</strong>
              <small>
                commit {update.build.commit} · published {new Date(update.build.publishedAt).toLocaleDateString()} ·{" "}
                {(update.build.gzSize / 1048576).toFixed(1)} MB download
              </small>
            </div>
            <button type="button" disabled={running || busy} onClick={() => void install()}>Install</button>
          </div>
        ) : (
          <div className="update-offer">
            <small>
              {checking || update === null ? 'Checking for updates…'
                : update.status === 'current' ? 'The simulator is up to date.'
                  : update.status === 'unconfigured' ? 'Updates are not set up in this copy of SimItBoi.'
                    : update.status === 'unreachable' ? 'Could not check for updates — you may be offline.'
                      : 'The update list could not be trusted, so it was ignored.'}
            </small>
            {update && update.status !== 'unconfigured' ? (
              <button type="button" className="ghost" disabled={checking || running || busy}
                onClick={() => void check(true)}>Check again</button>
            ) : null}
          </div>
        )}
      </div>

      {builds === null ? <p className="note">Reading installed builds…</p> : (
        <ul className="build-list">
          {builds.map((build) => (
            <li key={build.buildId} className={build.active ? 'active' : undefined}>
              <div>
                <span className="build-title">
                  <strong>{build.buildId}</strong>
                  {build.active ? <span className="tag">in use</span> : null}
                  {build.buildId === previousBuildId ? <span className="tag previous">previous</span> : null}
                </span>
                <small>{describe(build)}</small>
                {build.problems.length > 0
                  ? <small className="err">Damaged: {build.problems.join('; ')}</small>
                  : null}
              </div>
              {!build.active && build.problems.length === 0 ? (
                <button type="button" className="ghost" disabled={running || busy}
                  onClick={() => void act(() => api.activateSimcBuild(build.buildId), 'Now using')}>
                  Use this build
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button type="button" className="ghost" disabled={running || busy || !previous}
          title={previous ? undefined : 'There is no previous build to go back to'}
          onClick={() => void act(() => api.rollbackSimcBuild(), 'Rolled back to')}>
          Roll back to previous build
        </button>
      </div>
      {running ? <p className="note">Finish or cancel the running simulation to switch builds.</p> : null}
      {message ? <p className="note" role="status">{message}</p> : null}
      {error ? <p className="err" role="alert">{error}</p> : null}
    </section>
  )
}
