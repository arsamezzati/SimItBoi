/**
 * Electron main process.
 *
 * All sim orchestration lives here; the renderer only renders.
 */
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'

import { parseAddonProfile } from '../core/parser/addonProfile.ts'
import { catalog, catalogIdentity, searchCatalog, resolveCatalog, type CatalogSelection } from '../core/data/catalog.ts'
import { probeVersion, runSim } from '../core/simc/runner.ts'
import { extractReport } from '../core/report/extract.ts'
import { SingleJob } from '../core/simc/jobs.ts'
import { describeCandidates, runTopGear, type TopGearOptions } from '../core/topgear/funnel.ts'
import { Store, type ReportKind } from '../core/store/db.ts'
import { compareLoadouts } from '../core/topgear/loadouts.ts'
import { coverageFor, itemTable } from '../core/data/itemTable.ts'
import { legalEmbellishmentsFor, searchCraftedRecipes, resolveCrafted, CRAFTED_BASE_BONUS_ID, CRAFTED_STATS, type CraftedSelection } from '../core/data/crafted.ts'
import { embellishments, gems, enchants, embellishmentLimit, embellishmentSlots, socketCount } from '../core/data/db2.ts'
import { assertUsableSnapshot, dataIdentities, snapshotProblems } from '../core/data/manifest.ts'
import { probeItemStats, type ItemStatState } from '../core/data/itemStats.ts'
import { filterCandidates } from '../core/topgear/prepass.ts'
import { createHash, randomUUID } from 'node:crypto'
import { BackgroundScheduler } from '../core/data/backgroundScheduler.ts'
import { createRunEnvelope } from '../core/runEnvelope.ts'
import { sha256File } from '../core/simc/identity.ts'
import { checkForUpdate, installUpdate, type UpdateBuild, type UpdateCheck } from '../core/simc/update.ts'
import { SIMC_UPDATE_MANIFEST_BASE_URL, SIMC_UPDATE_PUBLIC_KEY } from '../core/simc/updateKey.ts'
import {
  activateBuild, buildsRoot, ensureProvisioned, listBuilds, pruneBuilds, readActive, rollback,
  verifyBuild, type Provisioned
} from '../core/simc/provision.ts'
import { requireCompatibleSimc } from '../core/simc/versionGate.ts'
import { previewCandidate, type ItemPreviewRequest } from '../core/data/itemPreview.ts'
import { itemStatKey } from '../core/data/itemStats.ts'
import { resolveDataDir, type DataDirChoice } from '../core/dataDir.ts'
import {
  ARMORY_REGIONS, ArmoryError, fetchArmoryProfile, fetchCharacterPortrait, fetchRealms, realmSlug,
  type ArmoryCredentials, type ArmoryRegion
} from '../core/armory/blizzard.ts'
import { averageItemLevel } from '../core/itemLevel.ts'
import type { ArmoryStatus } from '../core/api.ts'

/** Replaced at build time from .env; see electron.vite.config.ts. */
declare const __BLIZZARD_CLIENT_ID__: string
declare const __BLIZZARD_CLIENT_SECRET__: string

const __dirname_ = dirname(fileURLToPath(import.meta.url))

/**
 * Portable data directory. MUST run before app.whenReady().
 *
 * The decision itself lives in core/dataDir.ts so it can be tested without an
 * Electron app; this only supplies the Electron-shaped inputs.
 */
function currentDataDir(): DataDirChoice {
  return resolveDataDir({
    isPackaged: app.isPackaged,
    exeDir: dirname(app.getPath('exe')),
    electronAppData: app.getPath('appData'),
    devDir: process.env['SIMITBOI_DEV_DATA_DIR']
  })
}

const dataDir = currentDataDir()
app.setPath('userData', dataDir.dir)

/**
 * One instance per data directory.
 *
 * Two copies would open the same SQLite file, and the loser of that race
 * corrupts history rather than failing cleanly. Electron keys this lock on
 * userData, so it is taken *after* that is pointed at the portable folder:
 * scoping it to the data directory is what makes it mean "one app per install"
 * rather than "one app per machine", and lets a dev run and a packaged copy
 * coexist. Before the database is opened, either way.
 *
 * A second launch raises the existing window rather than doing nothing visible,
 * because a portable app that appears not to start gets double-clicked again.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

/**
 * Report history and saved profiles. Lives in the portable data dir, so
 * deleting the app folder still removes every trace.
 */
const store = new Store(openableDatabase(dataDir.dir))

/**
 * The app used to be called FastSim and kept history in fastsim.db. Move that
 * file (and SQLite's journal files beside it) the first time, so renaming the
 * app does not look like losing every saved report.
 */
function openableDatabase(dir: string): string {
  const path = join(dir, 'simitboi.db')
  const old = join(dir, 'fastsim.db')
  if (existsSync(path) || !existsSync(old)) return path
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(old + suffix)) renameSync(old + suffix, path + suffix)
  }
  return path
}

/** Newest-first history is capped so the file cannot grow without bound. */
const MAX_STORED_REPORTS = 200

function rememberProfile(raw: string): string | undefined {
  try {
    const p = parseAddonProfile(raw)
    if (!p.checksum) return undefined
    store.saveProfile({
      checksum: p.checksum,
      raw: p.raw,
      characterName: p.characterName,
      className: p.className,
      spec: p.spec,
      realm: p.header.realm ?? null,
      region: p.header.region ?? null
    })
    return p.checksum
  } catch {
    return undefined
  }
}

function persist(input: {
  kind: ReportKind; raw: string; dps?: number | null; delta?: number | null
  simcBuild?: string | null; durationMs?: number | null; label?: string | null; payload: unknown
}): string {
  const p = (() => { try { return parseAddonProfile(input.raw) } catch { return null } })()
  // Save the profile alongside the report so History can restore the exact
  // export that produced it. Done on completion, not on parse: parse runs on
  // every keystroke in the paste box.
  rememberProfile(input.raw)
  const id = randomUUID()
  store.saveReport({
    id,
    kind: input.kind,
    characterName: p?.characterName ?? null,
    className: p?.className ?? null,
    spec: p?.spec ?? null,
    dps: input.dps ?? null,
    delta: input.delta ?? null,
    simcBuild: input.simcBuild ?? null,
    durationMs: input.durationMs ?? null,
    profileChecksum: p?.checksum ?? null,
    label: input.label ?? null,
    payload: input.payload
  })
  store.pruneReports(MAX_STORED_REPORTS)
  return id
}

const SIMC_EXE = process.platform === 'win32' ? 'simc.exe' : 'simc'

/**
 * The build shipped inside the app, which first launch installs.
 *
 * Packaged, it is an extraResources directory holding just the executable.
 * In dev the vendored SimulationCraft download stands in; `include` is what
 * keeps the 423 MB of Qt beside it out of the build, since the CLI needs none
 * of it.
 */
function bundledSimc(): { dir: string; exe: string; version: string | null; include: readonly string[] } {
  const dir = app.isPackaged
    ? join(process.resourcesPath, 'simc')
    : process.env['SIMITBOI_SIMC_DIR'] ?? join(process.cwd(), 'vendor', 'simc')
  return { dir, exe: SIMC_EXE, version: null, include: [SIMC_EXE] }
}

/**
 * The active build, resolved once at startup and replaced only by an explicit
 * activation. Runs pin `simcPath()` at their start, so switching builds changes
 * what the next run uses rather than what a running one is executing.
 */
let provisioned: Provisioned | null = null
let provisionError: string | null = null
/**
 * Distinguishes 'not finished yet' from 'failed'. Both used to show as a null
 * build id, which reads as broken during the 116 MB first-launch copy and
 * leaves the renderer no way to say 'preparing' rather than 'unavailable'.
 */
let provisionState: 'provisioning' | 'ready' | 'failed' = 'provisioning'
/**
 * Resolves once the active build is settled. Installing the bundled build
 * copies 116 MB, so this deliberately does not gate the first window — a blank
 * screen while a file copies is a worse first launch than a window that is
 * briefly not ready to sim. Everything that spawns simc awaits it instead.
 */
let simcReady: Promise<void> = Promise.resolve()

/** Locates the simc executable of the active build. */
function simcPath(): string {
  if (provisioned) return provisioned.exe
  // Before provisioning finishes, or after it failed, fall back to the bundled
  // copy so a usable binary still beats a confusing 'no such file'.
  const bundled = bundledSimc()
  return join(bundled.dir, bundled.exe)
}

async function provisionSimc(): Promise<void> {
  try {
    const bundled = bundledSimc()
    // Ask the binary what it is before installing it, so build directories are
    // named '1210-01-<hash>' rather than 'unknown-<hash>'. Reports reference
    // their build by folder name, which only helps if the name means something. A probe failure is not fatal: the hash alone still
    // identifies the build uniquely.
    const version = await probeVersion(join(bundled.dir, bundled.exe)).catch(() => null)
    provisioned = await ensureProvisioned(dataDir.dir, { ...bundled, version: version?.build ?? null })
    provisionError = null
    provisionState = 'ready'
    if (provisioned.upgradedFrom) {
      console.log('simc upgraded from ' + provisioned.upgradedFrom + ' to ' + provisioned.manifest.buildId)
    }
    // Retention runs after activation, never before: the build just activated
    // and the one it replaced are both protected inside pruneBuilds.
    await pruneBuilds(provisioned.root, { keep: 2, protect: [provisioned.manifest.buildId] })
  } catch (error) {
    provisionError = (error as Error).message
    provisionState = 'failed'
    console.error('simc provisioning failed — ' + provisionError)
  }
}

/**
 * Every shipped data file fails validation loudly at startup rather than as a
 * stack trace from deep inside a require on first use.
 */
const dataProblems = snapshotProblems()
for (const problem of dataProblems) {
  console.error('Bundled data problem — ' + problem.file + ': ' + problem.problem)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    backgroundColor: '#14161a',
    // The packaged exe carries the icon already; this covers dev runs.
    icon: join(__dirname_, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname_, '../preload/index.mjs'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname_, '../renderer/index.html'))
  }
}

/** Tracks the in-flight sim so it can be cancelled by killing the child. */
const jobs = new SingleJob()
/** Sole owner of optional stat-probe children; never acquires the foreground lock. */
const itemStatJobs = new BackgroundScheduler<Record<string, ItemStatState>>(8,
  // A map holding any failure is not worth keeping: the whole point of asking
  // again is that the answer might be different. Caching it meant a probe that
  // failed once stayed failed for as long as its key lived, and no retry could
  // reach past it. A map with no failures is stable and worth reusing.
  (stats) => Object.values(stats).every((state) => state.status !== 'failed'))
let foregroundStarting = false

const MAX_PROBE_RAW_BYTES = 1_000_000
const MAX_PROBE_CANDIDATES = 250

/** Profile + binary + generated-data identity for bounded reusable probe results. */
function itemStatRequestKey(raw: string): string {
  const path = simcPath()
  const binary = statSync(path)
  const profile = createHash('sha256').update(raw).digest('hex')
  return [profile, path, binary.size, binary.mtimeMs, ...Object.values(dataIdentities())].join('|')
}

/** Foreground work closes the probe gate before waiting for child cleanup. */
async function runForeground<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  // A snapshot the app has already judged unusable must not reach a
  // simulation, because what comes out the other side looks like an answer.
  // Checked here rather than in each handler: this is the one door every
  // foreground run goes through.
  assertUsableSnapshot()
  // Never spawn a binary that is still being provisioned; the run pins its
  // path once, immediately after this resolves.
  await simcReady
  foregroundStarting = true
  try {
    await itemStatJobs.cancelAndWait()
    return await jobs.run(work)
  } finally {
    foregroundStarting = false
  }
}

ipcMain.handle('env:info', () => ({
  dataDir: dataDir.dir,
  dataProblems,
  portable: dataDir.portable,
  fellBack: dataDir.fellBack,
  dataDirReason: dataDir.reason,
  simcPath: simcPath(),
  simcState: provisionState,
  simcBuildId: provisioned?.manifest.buildId ?? null,
  simcVersionLabel: provisioned?.manifest.version ?? null,
  simcUpgradedFrom: provisioned?.upgradedFrom ?? null,
  simcUpdateAvailable: lastUpdateCheck?.status === 'available' ? lastUpdateCheck.build.version : null,
  simcSource: provisioned?.manifest.source ?? null,
  simcProblem: provisionError,
  isPackaged: app.isPackaged,
  logicalThreads: availableParallelism()
}))

/** Provisioned simc builds, and which one the next run will use. */
ipcMain.handle('simc:builds', async () => {
  try {
    const root = buildsRoot(dataDir.dir)
    const builds = await listBuilds(root)
    const verified = await Promise.all(builds.map(async (build) => ({
      buildId: build.buildId,
      version: build.version,
      source: build.source,
      provisionedAt: build.provisionedAt,
      active: build.buildId === provisioned?.manifest.buildId,
      problems: (await verifyBuild(root, build.buildId)).map((problem) => problem.problem)
    })))
    const active = await readActive(root)
    return { ok: true as const, builds: verified, previousBuildId: active?.previousBuildId ?? null, problem: provisionError }
  } catch (error) {
    return { ok: false as const, error: (error as Error).message }
  }
})

/**
 * Switches builds. Refused while a simulation is running: the run has already
 * pinned its binary, and reporting a build it did not use would be a lie.
 */
ipcMain.handle('simc:activate', async (_e, buildId: string) => {
  try {
    if (jobs.busy) throw new Error('Finish or cancel the running simulation before switching simc builds')
    const root = buildsRoot(dataDir.dir)
    const manifest = await activateBuild(root, String(buildId))
    provisioned = { root, manifest, exe: join(root, manifest.buildId, manifest.exe), installed: false, upgradedFrom: null }
    provisionError = null
    provisionState = 'ready'
    return { ok: true as const, buildId: manifest.buildId }
  } catch (error) {
    return { ok: false as const, error: (error as Error).message }
  }
})

/** Returns to the build that was active before the current one. */
/**
 * simc updates between releases (see core/simc/update.ts for the trust chain).
 *
 * The last check is cached here, and installing uses *that* build — the
 * renderer only says "install". It never gets to name a URL or checksum, so a
 * compromised page cannot make the app install something the signed manifest
 * did not list.
 */
let lastUpdateCheck: UpdateCheck | null = null
let updateCheckInFlight: Promise<UpdateCheck> | null = null

function updateSource(): { manifestBaseUrl: string; allowHttpHosts: readonly string[] } {
  // A local test server is allowed only in development; a packaged app talks
  // HTTPS to the published manifest and nothing else.
  const override = app.isPackaged ? undefined : process.env['SIMITBOI_SIMC_UPDATE_URL']
  return {
    manifestBaseUrl: override ?? SIMC_UPDATE_MANIFEST_BASE_URL,
    allowHttpHosts: app.isPackaged ? [] : ['127.0.0.1', 'localhost']
  }
}

async function runUpdateCheck(): Promise<UpdateCheck> {
  updateCheckInFlight ??= (async () => {
    await simcReady
    // Development only, for check:simc-update: a test key can stand in for the
    // real one. A packaged app ignores it, so a user cannot be talked into
    // trusting a different signer through an environment variable.
    const testKey = app.isPackaged ? undefined : process.env['SIMITBOI_SIMC_UPDATE_PUBLIC_KEY']
    const result = await checkForUpdate({
      ...updateSource(), publicKeyPem: testKey ?? SIMC_UPDATE_PUBLIC_KEY, root: buildsRoot(dataDir.dir)
    })
    lastUpdateCheck = result
    return result
  })().finally(() => { updateCheckInFlight = null })
  return await updateCheckInFlight
}

ipcMain.handle('simc:checkUpdate', async (_e, force = false) => {
  try {
    const result = !force && lastUpdateCheck ? lastUpdateCheck : await runUpdateCheck()
    return { ok: true as const, check: result }
  } catch (error) {
    return { ok: false as const, error: (error as Error).message }
  }
})

ipcMain.handle('simc:installUpdate', async (event) => {
  try {
    if (lastUpdateCheck?.status !== 'available') throw new Error('There is no simc update to install; check for updates first')
    const build: UpdateBuild = lastUpdateCheck.build
    // Foreground work: no simulation can start while the active build changes.
    const result = await runForeground((signal) => installUpdate(build, {
      root: buildsRoot(dataDir.dir),
      allowHttpHosts: updateSource().allowHttpHosts,
      signal,
      probe: probeVersion,
      onProgress: (progress) => { if (!event.sender.isDestroyed()) event.sender.send('simc:updateProgress', progress) }
    }))
    const root = buildsRoot(dataDir.dir)
    if (result.status === 'installed') {
      provisioned = { root, manifest: result.manifest, exe: join(root, result.manifest.buildId, result.manifest.exe), installed: true, upgradedFrom: result.previousBuildId }
      provisionError = null
      provisionState = 'ready'
      await pruneBuilds(root, { keep: 2, protect: [result.manifest.buildId] })
    }
    // Either way the offer is spent: installed, or rejected and never offered again.
    lastUpdateCheck = { status: 'current' }
    return { ok: true as const, result }
  } catch (error) {
    return { ok: false as const, error: (error as Error).message }
  }
})

ipcMain.handle('simc:rollback', async () => {
  try {
    if (jobs.busy) throw new Error('Finish or cancel the running simulation before switching simc builds')
    const root = buildsRoot(dataDir.dir)
    const manifest = await rollback(root)
    provisioned = { root, manifest, exe: join(root, manifest.buildId, manifest.exe), installed: false, upgradedFrom: null }
    provisionError = null
    provisionState = 'ready'
    return { ok: true as const, buildId: manifest.buildId }
  } catch (error) {
    return { ok: false as const, error: (error as Error).message }
  }
})

ipcMain.handle('simc:version', async () => {
  try {
    return { ok: true as const, version: await runForeground((signal) => probeVersion(simcPath(), signal)) }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message }
  }
})

ipcMain.handle('items:search', (_e, raw: string, query: string, slot?: string) => {
  try {
    assertUsableSnapshot()
    return { ok: true, ...searchCatalog(query, parseAddonProfile(raw).className, slot) }
  }
  catch (error) { return { ok: false, error: (error as Error).message } }
})
/**
 * The embellishment, gem and enchant lists. Static
 * generated data, so it is fetched once and cached by the renderer.
 */
ipcMain.handle('items:gearOptions', () => {
  try {
    assertUsableSnapshot()
    return {
      ok: true as const,
      // Each embellishment carries the slots it may go on, so the picker can
      // offer only legal ones. The main process re-checks on resolve regardless.
      embellishments: embellishments().map((e) => ({ ...e, slots: [...embellishmentSlots(e)] })),
      gems: [...gems()],
      enchants: [...enchants()],
      embellishmentLimit: embellishmentLimit()
    }
  } catch (error) {
    return { ok: false as const, error: (error as Error).message }
  }
})
/** Craftable recipes for the pasted character. */
ipcMain.handle('items:craftable', (_e, raw: string, query: string, slot?: string) => {
  try {
    assertUsableSnapshot()
    const className = parseAddonProfile(raw).className
    const matches = searchCraftedRecipes(String(query ?? ''), className, slot ?? '')
    const items = matches.slice(0, 60).map((r) => ({
      ...r,
      sockets: socketCount(r.itemId, [CRAFTED_BASE_BONUS_ID]),
      embellishmentBonusIds: legalEmbellishmentsFor(r).map((e) => e.bonusId)
    }))
    return { ok: true as const, items, total: matches.length, stats: [...CRAFTED_STATS] }
  } catch (error) {
    return { ok: false as const, error: (error as Error).message }
  }
})

ipcMain.handle('items:configureCrafted', (_e, raw: string, selection: CraftedSelection) => {
  try {
    assertUsableSnapshot()
    const resolved = resolveCrafted(selection, parseAddonProfile(raw).className)
    return { ok: true as const, item: { ...resolved, selection: { ...selection, kind: 'crafted' as const, ilvl: resolved.ilvl } } }
  } catch (error) {
    return { ok: false as const, error: (error as Error).message }
  }
})

ipcMain.handle('items:configure', (_e, raw: string, selection: CatalogSelection) => {
  // Stamp the identity resolution actually compares against. Stamping the
  // generation timestamp here while resolveCatalog compared a content hash made
  // every guided hypothetical item resolve when added and then be rejected at
  // run time, so Top Gear silently simulated without them.
  try {
    assertUsableSnapshot()
    return { ok: true, item: { ...resolveCatalog(selection, parseAddonProfile(raw).className), selection: { ...selection, catalogGenerated: catalogIdentity() } } }
  }
  catch (error) { return { ok: false, error: (error as Error).message } }
})
ipcMain.handle('profile:parse', (_e, raw: string) => {
  try {
    const p = parseAddonProfile(raw)
    return {
      ok: true as const,
      profile: {
        characterName: p.characterName,
        className: p.className,
        spec: p.spec,
        level: p.level,
        race: p.race,
        header: p.header,
        checksum: p.checksum,
        savedLoadouts: p.savedLoadouts.map((l) => l.name),
        equippedCount: p.equipped.length,
        itemLevel: averageItemLevel(p.equipped),
        bagCount: p.bagItems.length,
        extraLines: p.extraProfileLines.map((t) => t.key),
        warnings: p.warnings,
        candidates: describeCandidates(p),
        coverage: coverageFor([...p.equipped, ...p.bagItems].map((c) => c.item.id))
      }
    }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message }
  }
})

/**
 * Real stats for every candidate. Slot-packed, so a full bag costs a
 * handful of 1-iteration runs rather than one per item.
 */
ipcMain.handle('items:preview', async (_e, raw: string, request: ItemPreviewRequest, cancel = false) => {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_PROBE_RAW_BYTES) throw new Error('Profile is too large to probe')
    if (!request || JSON.stringify(request).length > 8192) throw new Error('Invalid item preview request')
    const key = `${itemStatRequestKey(raw)}|preview|${JSON.stringify(request)}`
    if (cancel) { itemStatJobs.cancelIf(key); return { ok: true, state: { status: 'pending' } } }
    // Wait in the renderer instead of cancelling the owned-gear probe or a different hover.
    if (foregroundStarting || jobs.busy || (itemStatJobs.busy && itemStatJobs.activeKey !== key)) {
      return { ok: true, state: { status: 'pending' } }
    }
    const profile = parseAddonProfile(raw)
    const { candidate, note } = previewCandidate(profile, request)
    const stats = await itemStatJobs.run(key, async signal => {
      if (foregroundStarting || jobs.busy) throw Object.assign(new Error('Preview yielded'), { name: 'AbortError' })
      const result = await probeItemStats(profile, [candidate], { simcPath: simcPath(), signal })
      const state = result.get(itemStatKey(candidate))!
      // Failure is retryable; do not retain it in the scheduler's success cache.
      if (state.status === 'failed' || state.status === 'missing') throw new Error(state.reason)
      return Object.fromEntries(result)
    })
    return { ok: true, state: stats[itemStatKey(candidate)], note }
  } catch (error) {
    if ((error as Error).name === 'AbortError') return { ok: true, state: { status: 'pending' } }
    return { ok: false, error: (error as Error).message }
  }
})

ipcMain.handle('items:stats', async (_e, raw: string) => {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_PROBE_RAW_BYTES) throw new Error('Profile is too large to probe')
    // Background probes bypass runForeground, so they wait here instead: the
    // cache key stats the binary, which does not exist until provisioning ends.
    await simcReady
    const key = itemStatRequestKey(raw)
    const stats = await itemStatJobs.run(key, async (signal) => {
      if (foregroundStarting || jobs.busy) {
        const error = new Error('Background probe yielded to a simulation'); error.name = 'AbortError'; throw error
      }
      const profile = parseAddonProfile(raw)
      const candidates = filterCandidates(profile, { preserveVariants: true })
      if (candidates.length > MAX_PROBE_CANDIDATES) throw new Error(`Too many item variants to probe (${candidates.length}/${MAX_PROBE_CANDIDATES})`)
      return Object.fromEntries(await probeItemStats(profile, candidates, { simcPath: simcPath(), signal }))
    })
    return { ok: true as const, stats }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { ok: true as const, stats: {} }
    return { ok: false as const, error: (err as Error).message }
  }
})

ipcMain.handle('items:stats:cancel', (_e, raw: string) => {
  try { itemStatJobs.cancelIf(itemStatRequestKey(raw)) } catch { /* no active matching request */ }
  return { ok: true as const }
})

/**
 * Armory lookups. The Blizzard API client comes from the user's own saved one
 * if any, else the one built in from .env when this copy was packaged.
 *
 * A saved client is encrypted with the operating system's per-user key, so the
 * file is useless copied to another account or machine; there it reads as
 * absent and the user enters it again.
 */
const ARMORY_CREDENTIALS_FILE = join(dataDir.dir, 'armory-credentials.bin')
const BUILT_IN_ARMORY: ArmoryCredentials | null = __BLIZZARD_CLIENT_ID__ && __BLIZZARD_CLIENT_SECRET__
  ? { clientId: __BLIZZARD_CLIENT_ID__, clientSecret: __BLIZZARD_CLIENT_SECRET__ }
  : null

function savedArmoryCredentials(): ArmoryCredentials | null {
  try {
    if (!safeStorage.isEncryptionAvailable() || !existsSync(ARMORY_CREDENTIALS_FILE)) return null
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(ARMORY_CREDENTIALS_FILE))) as ArmoryCredentials
    return parsed.clientId && parsed.clientSecret ? parsed : null
  } catch {
    return null
  }
}

function armoryCredentials(): { credentials: ArmoryCredentials | null; status: ArmoryStatus } {
  const own = savedArmoryCredentials()
  if (own) return { credentials: own, status: { source: 'own' } }
  if (BUILT_IN_ARMORY) return { credentials: BUILT_IN_ARMORY, status: { source: 'built-in' } }
  return { credentials: null, status: { source: 'none' } }
}

const NO_ARMORY = 'Armory search needs a Blizzard API client in this copy of SimItBoi. Add your own below, or paste a SimC addon string instead.'
const isRegion = (value: unknown): value is ArmoryRegion => ARMORY_REGIONS.includes(value as ArmoryRegion)

ipcMain.handle('armory:status', () => armoryCredentials().status)

ipcMain.handle('armory:import', async (_e, lookup: { region: unknown; realm: unknown; name: unknown }) => {
  try {
    const { credentials } = armoryCredentials()
    if (!credentials) return { ok: false as const, error: NO_ARMORY }
    if (!isRegion(lookup?.region) || typeof lookup.realm !== 'string' || typeof lookup.name !== 'string') {
      return { ok: false as const, error: 'Invalid armory lookup' }
    }
    const result = await fetchArmoryProfile({ region: lookup.region, realm: lookup.realm, name: lookup.name, credentials })
    return { ok: true as const, ...result }
  } catch (err) {
    const message = err instanceof ArmoryError ? err.message : 'Could not reach the Blizzard armory: ' + (err as Error).message
    return { ok: false as const, error: message }
  }
})

/**
 * Portraits for the profile card, for armory imports and pasted exports alike.
 * Kept for the session, including misses, so re-parsing on every keystroke in
 * the paste box asks Blizzard once per character.
 */
const portraitCache = new Map<string, Promise<string | null>>()
ipcMain.handle('armory:portrait', async (_e, lookup: { region: unknown; realm: unknown; name: unknown }) => {
  const { credentials } = armoryCredentials()
  const region = typeof lookup?.region === 'string' ? lookup.region.toLowerCase() : ''
  if (!credentials || !isRegion(region) || typeof lookup.realm !== 'string' || typeof lookup.name !== 'string') {
    return { ok: true as const, dataUrl: null }
  }
  const key = [region, realmSlug(lookup.realm), lookup.name.trim().toLowerCase()].join('/')
  if (!portraitCache.has(key)) {
    const pending = fetchCharacterPortrait({ region, realm: lookup.realm, name: lookup.name, credentials })
      // Offline or refused: no portrait, and try again next session rather than never.
      .catch(() => { portraitCache.delete(key); return null })
    portraitCache.set(key, pending)
  }
  return { ok: true as const, dataUrl: await portraitCache.get(key)! }
})

const realmCache = new Map<ArmoryRegion, Array<{ name: string; slug: string }>>()
ipcMain.handle('armory:realms', async (_e, region: unknown) => {
  try {
    if (!isRegion(region)) return { ok: false as const, error: 'Unknown region' }
    const { credentials } = armoryCredentials()
    if (!credentials) return { ok: false as const, error: NO_ARMORY }
    if (!realmCache.has(region)) realmCache.set(region, await fetchRealms(region, credentials))
    return { ok: true as const, realms: realmCache.get(region)! }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message }
  }
})

ipcMain.handle('armory:setCredentials', async (_e, input: ArmoryCredentials | null) => {
  try {
    realmCache.clear()
    if (input === null) {
      rmSync(ARMORY_CREDENTIALS_FILE, { force: true })
      return { ok: true as const, status: armoryCredentials().status }
    }
    const credentials = { clientId: String(input?.clientId ?? '').trim(), clientSecret: String(input?.clientSecret ?? '').trim() }
    if (!credentials.clientId || !credentials.clientSecret) return { ok: false as const, error: 'Enter both the client ID and the client secret.' }
    if (!safeStorage.isEncryptionAvailable()) return { ok: false as const, error: 'This system cannot store the secret securely, so it was not saved.' }
    // Prove it works before saving it: a typo should fail here, not on every lookup.
    await fetchRealms('us', credentials)
    writeFileSync(ARMORY_CREDENTIALS_FILE, safeStorage.encryptString(JSON.stringify(credentials)))
    return { ok: true as const, status: armoryCredentials().status }
  } catch (err) {
    return { ok: false as const, error: err instanceof ArmoryError ? err.message : (err as Error).message }
  }
})

ipcMain.handle('profile:remember', (_e, raw: string) => {
  const checksum = rememberProfile(raw)
  return checksum ? { ok: true as const, checksum } : { ok: false as const, error: 'Profile has no checksum' }
})

ipcMain.handle('loadouts:run', async (event, raw: string, opts: { threads?: number; fightSeconds?: number } = {}) => {
  try {
    const completed = await runForeground(async (signal) => {
      const profile = parseAddonProfile(raw)
      const path = simcPath()
      const version = await probeVersion(path, signal)
      if (!version) throw new Error('Could not identify the simc build')
      requireCompatibleSimc(profile, version)
      const threads = opts.threads ?? Math.max(1, availableParallelism() - 2)
      const fightSeconds = opts.fightSeconds ?? 300
      const sha256 = await sha256File(path, signal)
      const comparison = await compareLoadouts(profile, {
        simcPath: path,
        threads,
        fightSeconds,
        targetError: 0.15,
        signal,
        onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('sim:progress', p) }
      })
      if (await sha256File(path, signal) !== sha256) throw new Error('The simc binary changed during the run; results were discarded.')
      return { comparison, version, sha256, settings: { threads, fightSeconds, targetError: 0.15, profilesetWorkThreads: 2 } }
    })
    const { comparison, version, sha256, settings } = completed
    const best = comparison.results[0]
    const reportId = persist({
      kind: 'loadouts', raw,
      dps: best?.dps ?? comparison.baselineDps,
      delta: best?.delta ?? 0,
      simcBuild: version.build,
      durationMs: comparison.durationMs,
      payload: createRunEnvelope({ kind: 'loadouts', appVersion: app.getVersion(), input: raw, settings,
        simulator: { ...version, sha256 }, data: dataIdentities(), warnings: comparison.skipped.map((s) => `${s.name}: ${s.reason}`), result: comparison })
    })
    return { ok: true as const, comparison, reportId }
  } catch (err) {
    return { ok: false as const, error: (err as Error).name === 'AbortError' ? 'Comparison cancelled.' : (err as Error).message }
  }
})

ipcMain.handle('history:list', (_e, opts: { kind?: ReportKind; limit?: number; offset?: number } = {}) => {
  try {
    return { ok: true as const, reports: store.listReports(opts), total: store.countReports() }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message }
  }
})

ipcMain.handle('history:get', (_e, id: string) => {
  try {
    const found = store.getReport(id)
    if (!found) return { ok: false as const, error: 'Report not found' }
    return { ok: true as const, row: found.row, payload: found.payload }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message }
  }
})

ipcMain.handle('history:delete', (_e, id: string) => {
  try {
    return { ok: true as const, deleted: store.deleteReport(id) }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message }
  }
})

ipcMain.handle('profiles:list', () => {
  try {
    return { ok: true as const, profiles: store.listProfiles() }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message }
  }
})

ipcMain.handle('profiles:get', (_e, checksum: string) => {
  try {
    const found = store.getProfile(checksum)
    if (!found) return { ok: false as const, error: 'Profile not found' }
    return { ok: true as const, row: found.row, raw: found.raw }
  } catch (err) {
    return { ok: false as const, error: (err as Error).message }
  }
})

ipcMain.handle('sim:cancel', () => {
  jobs.cancel()
  return { ok: true }
})

ipcMain.handle('sim:run', async (event, raw: string, opts: { iterations?: number } = {}) => {
  try {
    return await runForeground(async (signal) => {
      const profile = parseAddonProfile(raw)
      const path = simcPath()
      const version = await probeVersion(path, signal)
      if (!version) throw new Error('Could not identify the simc build')
      requireCompatibleSimc(profile, version)
      const iterations = opts.iterations ?? 1000
      if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) throw new Error('Invalid iteration count')
      const sha256 = await sha256File(path, signal)
      const result = await runSim({ simcPath: path, input: `${profile.raw}\niterations=${iterations}\n`, signal,
        onProgress: (p) => { if (!event.sender.isDestroyed()) event.sender.send('sim:progress', p) } })
      const report = extractReport(result.json)
      if (!report) throw new Error('simc returned no player data')
      if (await sha256File(path, signal) !== sha256) throw new Error('The simc binary changed during the run; results were discarded.')
      const simcVersion = result.version?.build ?? version.build
      const reportId = persist({
        kind: 'quick', raw, dps: report.dps.mean, simcBuild: simcVersion,
        durationMs: result.durationMs,
        payload: createRunEnvelope({ kind: 'quick', appVersion: app.getVersion(), input: raw,
          settings: { iterations }, simulator: { ...(result.version ?? version), sha256 }, data: dataIdentities(), warnings: [], result: report })
      })
      return { ok: true as const, report, durationMs: result.durationMs,
        simcVersion, versionWarning: null, reportId }
    })
  } catch (err) {
    return { ok: false as const, error: (err as Error).name === 'AbortError' ? 'Simulation cancelled.' : (err as Error).message }
  }
})

ipcMain.handle('topgear:run', async (event, raw: string, opts: TopGearOptions) => {
  try {
    const result = await runForeground((signal) => runTopGear(raw, opts, {
      simcPath: simcPath(), signal,
      onProgress: (progress) => { if (!event.sender.isDestroyed()) event.sender.send('topgear:progress', progress) }
    }))
    const best = result.ranking[0]
    const reportId = persist({
      kind: 'topgear', raw,
      dps: best?.dps ?? result.baseline.dps.mean,
      delta: best?.delta ?? 0,
      simcBuild: result.version.build,
      durationMs: result.durationMs,
      payload: createRunEnvelope({ kind: 'topgear', appVersion: app.getVersion(), input: raw,
        settings: result.settings, simulator: { ...result.version, sha256: result.binarySha256 }, data: dataIdentities(), warnings: result.warnings, result })
    })
    return { ok: true as const, result, reportId }
  } catch (err) {
    return { ok: false as const, error: (err as Error).name === 'AbortError' ? 'Top Gear cancelled.' : (err as Error).message }
  }
})

void app.whenReady().then(() => {
  simcReady = provisionSimc()
  // Checked quietly in the background; offline or unconfigured is not an error.
  void simcReady.then(() => runUpdateCheck()).catch(() => {})
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitCleanupStarted = false
app.on('before-quit', (event) => {
  if (quitCleanupStarted || !itemStatJobs.busy) return
  event.preventDefault()
  quitCleanupStarted = true
  jobs.cancel()
  void itemStatJobs.cancelAndWait().finally(() => app.quit())
})

app.on('will-quit', () => {
  try { store.close() } catch { /* already closed */ }
})

app.on('window-all-closed', () => {
  jobs.cancel()
  itemStatJobs.cancel()
  if (process.platform !== 'darwin') app.quit()
})
