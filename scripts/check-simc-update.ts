/**
 * simc updates, end to end, in the real app with the real binary.
 *
 * The unit tests prove the rules with stand-in files. This proves the thing a
 * user actually does: open the Simulator panel, see an update, click Install,
 * and end up running a genuine simc that SimItBoi downloaded, verified,
 * decompressed and tested — and, separately, that a build which cannot start is
 * rolled back without leaving anything behind.
 *
 * Everything is local: a throwaway data directory, a throwaway signing key, and
 * an HTTP server on 127.0.0.1 serving a gzip of vendor/simc/simc.exe. Nothing is
 * downloaded from the internet and no real key is involved.
 *
 * Run `npm run build` first (check:ui does, if you ran it).
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { _electron as electron, expect, type Page } from '@playwright/test'

const require_ = createRequire(import.meta.url)
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

const realSimc = await readFile('vendor/simc/simc.exe')
const work = await mkdtemp(join(tmpdir(), 'simitboi-update-e2e-'))

// A throwaway signer standing in for the real update key.
const pair = generateKeyPairSync('ed25519')
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()

const files = new Map<string, Buffer>()
const server = createServer((request, response) => {
  const body = files.get(request.url ?? '')
  if (!body) { response.writeHead(404).end(); return }
  response.writeHead(200, { 'content-length': body.length }).end(body)
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port

/** Publishes one build and signs a manifest naming it, as the update workflow would. */
function publish(exe: Buffer, version: string, name: string): void {
  const gz = gzipSync(exe, { level: 9 })
  files.set('/builds/' + name, gz)
  const manifest = Buffer.from(JSON.stringify({
    schema: 1,
    builds: [{
      version, commit: 'c1935b9', url: base + '/builds/' + name,
      gzSha256: sha(gz), gzSize: gz.length, exeSha256: sha(exe), exeSize: exe.length,
      publishedAt: new Date().toISOString()
    }]
  }, null, 2))
  files.set('/update/simc-manifest.json', manifest)
  files.set('/update/simc-manifest.json.sig', Buffer.from(sign(null, manifest, pair.privateKey).toString('base64')))
}

async function launch(dataDir: string, bundledDir: string) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined)) as Record<string, string>
  delete env.ELECTRON_RENDERER_URL
  Object.assign(env, {
    SIMITBOI_DEV_DATA_DIR: dataDir,
    SIMITBOI_SIMC_DIR: bundledDir,
    SIMITBOI_SIMC_UPDATE_URL: base + '/update/',
    SIMITBOI_SIMC_UPDATE_PUBLIC_KEY: publicKey
  })
  const app = await electron.launch({ executablePath: require_('electron') as string, args: ['out/main/index.js'], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(120_000)
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.hide() })
  return { app, page }
}

const panel = (page: Page) => page.getByRole('region', { name: 'Simulator builds' })

try {
  // An install whose bundled simulator is an old, unusable stand-in — so the
  // only way to end up with a working simc is the update.
  const dataDir = join(work, 'data')
  const bundledDir = join(work, 'bundle')
  await mkdir(bundledDir, { recursive: true })
  await writeFile(join(bundledDir, 'simc.exe'), 'an outdated stand-in simulator')

  // --- Scenario 1: a genuine update is offered, installed and used ---------
  publish(realSimc, '1210-01', 'simc-1210-01.exe.gz')
  let { app, page } = await launch(dataDir, bundledDir)
  try {
    // The header offers it without anyone opening a panel.
    const badge = page.locator('.meta').getByRole('button', { name: /simc 1210-01 available/ })
    await expect(badge).toBeVisible({ timeout: 120_000 })
    await badge.click()
    await expect(panel(page)).toContainText('simc 1210-01 is available')
    await panel(page).getByRole('button', { name: 'Install', exact: true }).click()
    await expect(panel(page).getByRole('status').last()).toContainText('Now using 1210-01-', { timeout: 300_000 })

    const env = await page.evaluate(() => (window as any).simitboi.envInfo())
    const installed = await readFile(String(env.simcPath))
    assert.equal(sha(installed), sha(realSimc), 'the installed simc.exe is not byte-identical to the published one')
    const version = await page.evaluate(() => (window as any).simitboi.simcVersion())
    assert.equal(version.ok && version.version?.build, '1210-01', 'the app is not running the updated simulator')
    // Offered once, installed, not offered again.
    await expect(panel(page)).toContainText('The simulator is up to date.')
    console.log('installed : ' + env.simcBuildId + ' (' + (files.get('/builds/simc-1210-01.exe.gz')!.length / 1048576).toFixed(1) + ' MB download, byte-identical)')
  } finally {
    await app.close()
  }

  // --- Scenario 2: a build that cannot start is rolled back ----------------
  publish(Buffer.from('this is not a Windows program'), '1215-01', 'simc-1215-01.exe.gz');
  ({ app, page } = await launch(dataDir, bundledDir))
  try {
    // The badge appears only once the simulator has settled, so the build id read
    // after it is the real starting point rather than a mid-startup null.
    const badge = page.locator('.meta').getByRole('button', { name: /simc 1215-01 available/ })
    await expect(badge).toBeVisible({ timeout: 120_000 })
    const before = await page.evaluate(() => (window as any).simitboi.envInfo())
    assert.ok(before.simcBuildId, 'the simulator had not settled before the update was offered')
    await badge.click()
    await panel(page).getByRole('button', { name: 'Install', exact: true }).click()
    await expect(panel(page).getByRole('alert')).toContainText('was not kept', { timeout: 300_000 })

    const after = await page.evaluate(() => (window as any).simitboi.envInfo())
    assert.equal(after.simcBuildId, before.simcBuildId, 'a build that could not start was left active')
    const version = await page.evaluate(() => (window as any).simitboi.simcVersion())
    assert.equal(version.ok && version.version?.build, '1210-01', 'the app no longer runs its working simulator')
    const root = join(dataDir, 'simc')
    const builds = (await readdir(root)).filter((name) => !name.startsWith('.') && !name.endsWith('.json'))
    assert.ok(!builds.some((name) => name.startsWith('1215-01')), 'the failed build was left installed: ' + builds.join(', '))
    // And it is not offered again after a restart-free recheck.
    const recheck = await page.evaluate(() => (window as any).simitboi.checkSimcUpdate(true))
    assert.equal(recheck.ok && recheck.check.status, 'current', 'a failed build was offered again')
    console.log('rolled back: a build that could not start was refused and removed; ' + after.simcBuildId + ' still active')
  } finally {
    await app.close()
  }

  console.log('\nAll simc update checks passed.')
} finally {
  server.close()
  await rm(work, { recursive: true, force: true }).catch(() => {})
}

