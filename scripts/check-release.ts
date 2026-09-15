/**
 * Clean-Windows release checks.
 *
 * Everything else in this repository tests the app as a developer runs it:
 * `out/main/index.js` under a dev Electron, with the repository, Node and a
 * vendored simc all sitting right there. None of that is true for the person
 * who unzips the release, and every one of those differences has produced a bug
 * that only appears on their machine.
 *
 * So this drives the *packaged* SimItBoi.exe, copied to a path with spaces and
 * non-ASCII in it, offline, with no environment pointing at the repository.
 *
 * Run `npm run package` first.
 */
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'

const require_ = createRequire(import.meta.url)

/**
 * The preload bridge, as the page sees it.
 *
 * Declared once rather than cast at each call site: the nine casts this
 * replaces each described `window.simitboi` a little differently and none was
 * checked against the real thing. The methods are loosely typed on purpose —
 * these assertions poke at responses generically, and importing the full
 * SimItBoiApi here would tie a release check to every renderer type.
 */
type Bridge = Record<string, (...args: unknown[]) => Promise<Record<string, unknown>>>
declare global {
  interface Window { simitboi: Bridge }
}

const UNPACKED = resolve('release', 'win-unpacked')
const EXE = 'SimItBoi.exe'

/**
 * Spaces and non-ASCII, because both are known hazards and the fix
 * for both is the same: never build a command string, always pass argv.
 */
const AWKWARD = join('WoW Stuff', 'Sim It Boi é測試')

/** True for anything inside a `data` directory of the packaged tree. */
function isUnderData(source: string): boolean {
  // Split on the platform separator rather than a regex character class: a
  // literal backslash is exactly the thing that gets lost in transit, and a
  // filter that silently only matched forward slashes on Windows would be a
  // no-op that looks fine.
  return relative(UNPACKED, source).split(sep).includes('data')
}

/** Windows path separator, built rather than typed so it survives tooling. */
const KEY_SEP = String.fromCharCode(92)

/**
 * Whether Windows Smart App Control is enforcing.
 *
 * It blocks unsigned executables outright — not the SmartScreen prompt with an
 * override, an outright refusal to start — and a freshly built exe has no
 * reputation to appeal to. Playwright reports that as 'Process failed to
 * launch!', which sends you hunting a packaging bug that does not exist.
 */
function smartAppControlEnforcing(): boolean {
  if (process.platform !== 'win32') return false
  try {
    const key = ['HKLM', 'SYSTEM', 'CurrentControlSet', 'Control', 'CI', 'Policy'].join(KEY_SEP)
    const out = execFileSync('reg', [
      'query', key, '/v', 'VerifiedAndReputablePolicyState'
    ], { encoding: 'utf8' })
    // 0 off, 1 enforcing, 2 evaluation.
    const enforcing = new RegExp(
      ['VerifiedAndReputablePolicyState', 's+REG_DWORD', 's+0x1'].join(KEY_SEP), 'i'
    )
    return enforcing.test(out)
  } catch {
    return false
  }
}

await stat(join(UNPACKED, EXE)).catch(() => {
  throw new Error('release/win-unpacked/' + EXE + ' is missing — run `npm run package` first')
})

if (smartAppControlEnforcing()) {
  throw new Error(
    'Windows Smart App Control is enforcing on this machine, so it will refuse to start the ' +
    'unsigned ' + EXE + ' and this check cannot run. That is a real release finding rather than ' +
    'a local inconvenience: every user with it enabled is blocked the same way, and no ' +
    'SmartScreen-style override is offered. Code signing is the only fix. ' +
    'To run this check anyway, turn Smart App Control off in Windows Security > App & browser ' +
    'control (it cannot be re-enabled without reinstalling Windows).'
  )
}

/**
 * A launch environment with nothing that could hand the app a shortcut: no
 * dev data directory, no renderer URL, and no sign it was started from a repo.
 */
function cleanEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) =>
      key !== 'ELECTRON_RUN_AS_NODE' && key !== 'SIMITBOI_DEV_DATA_DIR' &&
      key !== 'ELECTRON_RENDERER_URL' && key !== 'SIMITBOI_SIMC_DIR' && value !== undefined)
  ) as Record<string, string>
  return env
}

const profile = await readFile('fixtures/vahshandooz-elemental.simc', 'utf8')
const root = await mkdtemp(join(tmpdir(), 'simitboi-release-'))
const installDir = join(root, AWKWARD)

try {
  console.log('installing to', installDir)
  // Skip any `data` directory the packaged tree has picked up from someone
  // running the exe in place: this check exists to test a *first* launch, and
  // copying a previous run's database would test something else entirely. It
  // also avoids EBUSY on files a live instance still holds open.
  await cp(UNPACKED, installDir, {
    recursive: true,
    filter: (source) => !isUnderData(source)
  })
  const exe = join(installDir, EXE)

  /** Launches the packaged executable itself, not a dev Electron. */
  const launch = (): Promise<ElectronApplication> =>
    electron.launch({ executablePath: exe, args: [], env: cleanEnv(), timeout: 120_000 })

  // --- First launch -------------------------------------------------------
  let app = await launch()
  let page = await app.firstWindow()
  page.setDefaultTimeout(60_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  // Offline from the first moment: a portable app must sim with no network.
  await page.context().setOffline(true)
  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.hide() })

  /** First launch installs 116 MB, so wait for that to settle before judging it. */
  const settled = async (): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const env = await page.evaluate(() => window.simitboi.envInfo())
      if (env.simcState !== 'provisioning') return env
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('simc provisioning never finished')
  }
  // The renderer probes the simc version on load, and that probe holds the
  // same foreground lock a simulation needs. Wait for it, exactly as a user
  // would by watching the header settle.
  await expect(page.locator('.meta')).not.toContainText('checking', { timeout: 180_000 })
  const info = await settled()
  assert.equal(info.simcState, 'ready', 'provisioning failed: ' + info.simcProblem)
  assert.equal(info.isPackaged, true, 'the packaged app does not think it is packaged')
  assert.equal(info.portable, true)
  assert.equal(info.fellBack, false, 'a writable install directory was rejected: ' + info.dataDirReason)
  assert.equal(info.dataDir, join(installDir, 'data'), 'data did not land beside the executable')
  assert.deepEqual(info.dataProblems, [], 'the shipped data snapshot does not validate')
  console.log('data dir  :', info.dataDir)

  // The simulator came from the bundle, not from a vendor folder that is not
  // on this machine at all.
  assert.ok(info.simcBuildId, 'no simc build was provisioned: ' + info.simcProblem)
  assert.equal(info.simcSource, 'bundled')
  assert.ok(String(info.simcPath).startsWith(String(info.dataDir)),
    'the app is running a simulator outside its data directory: ' + info.simcPath)
  console.log('simc build:', info.simcBuildId)

  // --- It actually simulates ---------------------------------------------
  const first = await page.evaluate(async (raw) => {
    const api = window.simitboi
    return await api.runSim(raw, { iterations: 100 })
  }, profile)
  assert.equal(first.ok, true, 'the packaged app could not simulate: ' + first.error)
  const dps = (first.report as { dps: { mean: number } }).dps.mean
  assert.ok(dps > 0, 'the packaged app produced no DPS')
  console.log('quick sim :', Math.round(dps).toLocaleString(), 'dps')

  // --- Cancellation releases the child ------------------------------------
  const cancelled = await page.evaluate(async (raw) => {
    const api = window.simitboi
    const running = api.runSim(raw, { iterations: 100000 })
    await new Promise((r) => setTimeout(r, 1500))
    await api.cancelSim()
    const outcome = await running
    // The lock must be free immediately afterwards, not merely eventually.
    const after = await api.runSim(raw, { iterations: 50 })
    return { outcome, after: after.ok }
  }, profile)
  assert.equal(cancelled.outcome.ok, false, 'a cancelled run reported success')
  assert.equal(cancelled.after, true, 'the job lock was not released after cancelling')
  console.log('cancel    : released the lock')

  // --- A second instance does not open a second database ------------------
  const second = await launch().then(
    async (other) => { await other.close(); return 'opened' },
    () => 'refused'
  )
  assert.equal(second, 'refused', 'a second instance opened against the same data directory')
  console.log('second run: refused')

  // --- History survives a restart -----------------------------------------
  const before = await page.evaluate(() => window.simitboi.listHistory({ limit: 1 }))
  assert.equal(before.ok, true)
  assert.ok(Number(before.total) >= 2, 'the packaged app saved no history')
  await app.close()

  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(60_000)
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.hide() })
  await expect(page.locator('.meta')).not.toContainText('checking', { timeout: 180_000 })
  const after = await page.evaluate(() => window.simitboi.listHistory({ limit: 1 }))
  assert.equal(after.total, before.total, 'history did not survive a restart')

  // The build is reused on the second launch rather than reinstalled.
  const reopened = await settled()
  assert.equal(reopened.simcBuildId, info.simcBuildId, 'the simc build changed across a restart')
  console.log('restart   : history and build both intact')

  // --- A damaged build is repaired rather than run ------------------------
  const builds = await page.evaluate(() => window.simitboi.simcBuilds())
  assert.equal(builds.ok, true)
  const active = (builds.builds as Array<{ active: boolean; problems: string[] }>).find((b) => b.active)
  assert.ok(active && active.problems.length === 0, 'the active build does not verify')
  await app.close()

  await writeFile(String(info.simcPath), 'corrupted')
  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(120_000)
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.hide() })
  await expect(page.locator('.meta')).not.toContainText('checking', { timeout: 180_000 })
  await settled()
  const repaired = await page.evaluate(() => window.simitboi.simcBuilds())
  const healthy = (repaired.builds as Array<{ active: boolean; problems: string[] }>).find((b) => b.active)
  assert.ok(healthy && healthy.problems.length === 0, 'a corrupted simc build was left active')
  const afterRepair = await page.evaluate(async (raw) => {
    const api = window.simitboi
    return await api.runSim(raw, { iterations: 50 })
  }, profile)
  assert.equal(afterRepair.ok, true, 'the app could not sim after repairing a damaged build')
  console.log('repair    : a corrupted binary was replaced and the app still sims')

  // --- An unwritable install falls back instead of failing silently --------
  // A second copy, with a *file* named `data` where the directory must go. That
  // is the same ENOTDIR a read-only Program Files install produces, without
  // needing ACLs or an elevated run, and a silent fallback here is a miserable
  // bug to diagnose.
  await app.close()
  const lockedDir = join(root, 'Read Only Install')
  await cp(UNPACKED, lockedDir, {
    recursive: true,
    filter: (source) => !isUnderData(source)
  })
  await writeFile(join(lockedDir, 'data'), 'not a directory')
  // LOCALAPPDATA is redirected into the sandbox for this launch only. Without
  // that the check would write into — and on cleanup could delete — a real
  // SimItBoi install belonging to whoever ran it.
  const fallbackHome = join(root, 'LocalAppData')
  const lockedApp = await electron.launch({
    executablePath: join(lockedDir, EXE), args: [],
    env: {
      ...cleanEnv(),
      LOCALAPPDATA: fallbackHome,
      // Development-only update overrides. A packaged app must ignore both,
      // or a user could be talked into trusting a different signer by setting
      // an environment variable. Asserted below.
      SIMITBOI_SIMC_UPDATE_URL: 'http://127.0.0.1:9/update/',
      SIMITBOI_SIMC_UPDATE_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----\n'
    },
    timeout: 120_000
  })
  try {
    const lockedPage = await lockedApp.firstWindow()
    lockedPage.setDefaultTimeout(60_000)
    await lockedPage.waitForLoadState('domcontentloaded')
    await lockedApp.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.hide() })
    const fallback = await lockedPage.evaluate(() => window.simitboi.envInfo())
    assert.equal(fallback.fellBack, true, 'an unwritable install did not fall back')
    assert.notEqual(fallback.dataDir, join(lockedDir, 'data'))
    assert.equal(fallback.dataDir, join(fallbackHome, 'SimItBoi'),
      'the fallback did not land in LOCALAPPDATA: ' + fallback.dataDir)
    assert.ok(String(fallback.dataDirReason).includes('not writable'),
      'the fallback did not explain itself: ' + fallback.dataDirReason)
    // And the fallback location is genuinely usable, not merely chosen.
    await lockedApp.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    console.log('read-only : fell back to', fallback.dataDir)

    // With no signing key built into this build, updates are off — and the
    // injected test key above did not switch them on.
    const update = await lockedPage.evaluate(() => window.simitboi.checkSimcUpdate(true))
    assert.equal(update.ok, true)
    assert.equal((update.check as { status: string }).status, 'unconfigured',
      'a packaged app accepted an update signing key from the environment: ' + JSON.stringify(update))
    console.log('overrides : a packaged app ignored the development update key and URL')
  } finally {
    await lockedApp.close()
  }

  assert.deepEqual(errors, [], 'the renderer raised errors')

  // --- Deleting the folder removes every trace ----------------------------
  const stray = (await readdir(installDir)).filter((name) => name === 'data')
  assert.deepEqual(stray, ['data'], 'the app did not keep its state beside the executable')

  await app.close()
  console.log('\nAll release checks passed:', installDir)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => { /* the app may still hold a handle */ })
  void require_
}
