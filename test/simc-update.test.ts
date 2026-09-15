import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, constants as zlibConstants } from 'node:zlib'
import { buildsRoot, ensureProvisioned, readActive, verifyBuild } from '../src/core/simc/provision.ts'
import {
  UPDATE_MANIFEST_SCHEMA, checkForUpdate, installUpdate, pickUpdate, readSignedManifest,
  validateManifest, type UpdateBuild, type UpdateManifest
} from '../src/core/simc/update.ts'

/**
 * simc updates between releases.
 *
 * Every case runs against a real HTTP server on localhost, with a real Ed25519
 * key pair, so signature checks, streaming and hash verification are exercised
 * as they run in the app — not mocked. The "simulators" are small stand-in
 * files; the probe that normally runs simc is replaced by a function reporting
 * whatever version the test wants, including none.
 */

const LOCAL = ['127.0.0.1']
const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

function keys(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('ed25519')
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

async function serve(t: { after: (fn: () => unknown) => void }, files: Map<string, Buffer>): Promise<string> {
  const server: Server = createServer((request, response) => {
    const body = files.get(request.url ?? '')
    if (!body) { response.writeHead(404).end(); return }
    response.writeHead(200, { 'content-length': body.length }).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}

interface World {
  data: string
  root: string
  base: string
  files: Map<string, Buffer>
  signer: ReturnType<typeof keys>
  /** Publishes a simulator as an approved build and signs a manifest listing it. */
  publish: (exe: string, version: string, overrides?: Partial<UpdateBuild>) => UpdateBuild
}

async function world(t: { after: (fn: () => unknown) => void }): Promise<World> {
  const data = await mkdtemp(join(tmpdir(), 'simitboi-update-test-'))
  t.after(() => rm(data, { recursive: true, force: true }))
  // An existing install, the way a user has one: bundled 1210-01 active.
  const bundledDir = join(data, 'bundle')
  await mkdir(bundledDir)
  await writeFile(join(bundledDir, 'simc.exe'), 'bundled simc 1210-01')
  await ensureProvisioned(data, { dir: bundledDir, exe: 'simc.exe', version: '1210-01', include: ['simc.exe'] })

  const files = new Map<string, Buffer>()
  const base = await serve(t, files)
  const signer = keys()
  const publish = (exe: string, version: string, overrides: Partial<UpdateBuild> = {}): UpdateBuild => {
    const raw = Buffer.from(exe)
    const gz = gzipSync(raw)
    const path = '/builds/' + sha(raw).slice(0, 12) + '.gz'
    files.set(path, gz)
    const build: UpdateBuild = {
      version, commit: 'c1935b9', url: base + path,
      gzSha256: sha(gz), gzSize: gz.length, exeSha256: sha(raw), exeSize: raw.length,
      publishedAt: '2026-09-15T00:00:00Z', ...overrides
    }
    const manifest = Buffer.from(JSON.stringify({ schema: UPDATE_MANIFEST_SCHEMA, builds: [build] }))
    files.set('/update/simc-manifest.json', manifest)
    files.set('/update/simc-manifest.json.sig', Buffer.from(sign(null, manifest, signer.privateKey).toString('base64')))
    return build
  }
  return { data, root: buildsRoot(data), base, files, signer, publish }
}

const reports = (version: string | null) => async (): Promise<{ build: string } | null> =>
  version === null ? null : { build: version }

// --- The signature is the trust boundary ------------------------------------

test('a correctly signed manifest is accepted', async (t) => {
  const w = await world(t)
  w.publish('simc 1215-01', '1215-01')
  const manifest = readSignedManifest(w.files.get('/update/simc-manifest.json')!,
    w.files.get('/update/simc-manifest.json.sig')!.toString(), w.signer.publicKey, LOCAL)
  assert.equal(manifest.builds[0]!.version, '1215-01')
})

test('a manifest altered after signing is refused', async (t) => {
  const w = await world(t)
  w.publish('simc 1215-01', '1215-01')
  const original = w.files.get('/update/simc-manifest.json')!.toString()
  // An attacker swaps in their own file's checksum but cannot re-sign.
  const tampered = Buffer.from(original.replace(/"exeSha256":"[0-9a-f]+"/, '"exeSha256":"' + 'a'.repeat(64) + '"'))
  assert.throws(
    () => readSignedManifest(tampered, w.files.get('/update/simc-manifest.json.sig')!.toString(), w.signer.publicKey, LOCAL),
    /signature is not valid/
  )
})

test('a manifest signed by a different key is refused', async (t) => {
  const w = await world(t)
  w.publish('simc 1215-01', '1215-01')
  assert.throws(
    () => readSignedManifest(w.files.get('/update/simc-manifest.json')!,
      w.files.get('/update/simc-manifest.json.sig')!.toString(), keys().publicKey, LOCAL),
    /signature is not valid/
  )
})

test('with no key built in, no manifest is ever trusted', () => {
  assert.throws(() => readSignedManifest(Buffer.from('{}'), 'AAAA', null), /not configured/)
})

test('manifest shape is checked, including plain-HTTP downloads', () => {
  const good: UpdateBuild = {
    version: '1215-01', commit: 'c1935b9', url: 'https://example.invalid/simc.exe.gz',
    gzSha256: 'a'.repeat(64), gzSize: 100, exeSha256: 'b'.repeat(64), exeSize: 1000, publishedAt: '2026-09-15T00:00:00Z'
  }
  assert.doesNotThrow(() => validateManifest({ schema: 1, builds: [good] }))
  assert.throws(() => validateManifest({ schema: 2, builds: [good] }), /unsupported schema/)
  assert.throws(() => validateManifest({ schema: 1, builds: [{ ...good, url: 'http://example.invalid/x.gz' }] }), /not https/)
  // Localhost HTTP only when the caller explicitly allows it, as tests do.
  assert.throws(() => validateManifest({ schema: 1, builds: [{ ...good, url: 'http://127.0.0.1/x.gz' }] }), /not https/)
  assert.doesNotThrow(() => validateManifest({ schema: 1, builds: [{ ...good, url: 'http://127.0.0.1/x.gz' }] }, LOCAL))
  assert.throws(() => validateManifest({ schema: 1, builds: [{ ...good, exeSha256: 'nope' }] }), /bad exeSha256/)
  assert.throws(() => validateManifest({ schema: 1, builds: [{ ...good, version: 'latest' }] }), /unreadable version/)
  assert.throws(() => validateManifest({ schema: 1, builds: [{ ...good, gzSize: 10 ** 12 }] }), /too large/)
})

// --- Deciding whether to offer ----------------------------------------------

test('a newer approved build is offered', async (t) => {
  const w = await world(t)
  const build = w.publish('simc 1215-01', '1215-01')
  const check = await checkForUpdate({ manifestBaseUrl: w.base + '/update/', publicKeyPem: w.signer.publicKey, root: w.root, allowHttpHosts: LOCAL })
  assert.equal(check.status, 'available')
  assert.equal(check.status === 'available' && check.build.exeSha256, build.exeSha256)
})

test('a build that is already installed, or older, is not offered', async (t) => {
  const w = await world(t)
  const same = w.publish('bundled simc 1210-01', '1210-01')
  assert.equal(await pickUpdate(w.root, { schema: 1, builds: [same] }), null, 'the installed build was offered again')

  const older = w.publish('simc 1205-03', '1205-03')
  assert.equal(await pickUpdate(w.root, { schema: 1, builds: [older] }), null, 'an older build was offered')
})

test('being offline, unconfigured, or served a bad signature is not an error', async (t) => {
  const w = await world(t)
  w.publish('simc 1215-01', '1215-01')
  const base = { root: w.root, allowHttpHosts: LOCAL }

  const unconfigured = await checkForUpdate({ ...base, manifestBaseUrl: w.base + '/update/', publicKeyPem: null })
  assert.equal(unconfigured.status, 'unconfigured')

  const missing = await checkForUpdate({ ...base, manifestBaseUrl: w.base + '/nowhere/', publicKeyPem: w.signer.publicKey })
  assert.equal(missing.status, 'unreachable')

  const offline = await checkForUpdate({ ...base, manifestBaseUrl: 'http://127.0.0.1:9/update/', publicKeyPem: w.signer.publicKey })
  assert.equal(offline.status, 'unreachable')

  const wrongKey = await checkForUpdate({ ...base, manifestBaseUrl: w.base + '/update/', publicKeyPem: keys().publicKey, retryDelayMs: 0 })
  assert.equal(wrongKey.status, 'invalid')
})

test('a check that lands between the manifest and signature uploads asks again', async (t) => {
  const w = await world(t)
  w.publish('simc 1212-01', '1212-01')
  const stale = w.files.get('/update/simc-manifest.json.sig')!.toString()
  const build = w.publish('simc 1215-01', '1215-01')
  // The first answer pairs the new manifest with a signature for the old one.
  let calls = 0
  const racing: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('.sig') && calls++ === 0) return new Response(stale)
    return await fetch(input, init)
  }
  const check = await checkForUpdate({
    manifestBaseUrl: w.base + '/update/', publicKeyPem: w.signer.publicKey, root: w.root,
    allowHttpHosts: LOCAL, fetchImpl: racing, retryDelayMs: 0
  })
  assert.equal(check.status === 'available' && check.build.exeSha256, build.exeSha256)
})

// --- Installing --------------------------------------------------------------

test('an approved build downloads, verifies, installs and becomes active', async (t) => {
  const w = await world(t)
  const before = await readActive(w.root)
  const build = w.publish('simc 1215-01', '1215-01')
  const stages: string[] = []
  let lastFraction = 0

  const result = await installUpdate(build, {
    root: w.root, allowHttpHosts: LOCAL, probe: reports('1215-01'),
    onProgress: (p) => { stages.push(p.stage); if (p.fraction !== undefined) lastFraction = p.fraction }
  })

  assert.equal(result.status, 'installed')
  if (result.status !== 'installed') return
  assert.equal(result.manifest.files['simc.exe'], build.exeSha256)
  assert.equal(await readFile(join(w.root, result.manifest.buildId, 'simc.exe'), 'utf8'), 'simc 1215-01')
  const active = await readActive(w.root)
  assert.equal(active?.buildId, result.manifest.buildId)
  assert.equal(active?.previousBuildId, before?.buildId, 'the old build is not the rollback target')
  assert.deepEqual([...new Set(stages)], ['downloading', 'verifying', 'installing', 'testing'])
  assert.equal(lastFraction, 1)
  // No working files left behind.
  assert.deepEqual((await readdir(w.root)).filter((name) => name.startsWith('.staging')), [])
  // And it is not offered again.
  assert.equal(await pickUpdate(w.root, { schema: 1, builds: [build] }), null)
})

test('a download that does not match its checksum installs nothing', async (t) => {
  const w = await world(t)
  const before = await readActive(w.root)
  const build = w.publish('simc 1215-01', '1215-01')
  // The server now hands out something else under the approved URL.
  w.files.set(new URL(build.url).pathname, gzipSync(Buffer.from('malicious replacement')))

  await assert.rejects(
    () => installUpdate(build, { root: w.root, allowHttpHosts: LOCAL, probe: reports('1215-01') }),
    /(downloaded simc does not match the approved checksum|exceeded)/
  )
  assert.deepEqual(await readActive(w.root), before, 'the active build changed')
  const builds = (await readdir(w.root)).filter((name) => !name.startsWith('.') && !name.endsWith('.json'))
  assert.equal(builds.length, 1, 'a build directory was created: ' + builds.join(', '))
})

test('a checksum-valid download whose simc.exe does not match installs nothing', async (t) => {
  const w = await world(t)
  const before = await readActive(w.root)
  const build = w.publish('simc 1215-01', '1215-01', { exeSha256: 'c'.repeat(64) })
  await assert.rejects(
    () => installUpdate(build, { root: w.root, allowHttpHosts: LOCAL, probe: reports('1215-01') }),
    /decompressed simc.exe does not match/
  )
  assert.deepEqual(await readActive(w.root), before)
})

test('a download larger than approved is cut off', async (t) => {
  const w = await world(t)
  const build = w.publish('simc 1215-01', '1215-01')
  w.files.set(new URL(build.url).pathname, Buffer.alloc(build.gzSize * 20, 1))
  await assert.rejects(
    () => installUpdate(build, { root: w.root, allowHttpHosts: LOCAL, probe: reports('1215-01') }),
    /exceeded/
  )
})

test('a build that will not start here is rolled back and never offered again', async (t) => {
  const w = await world(t)
  const before = await readActive(w.root)
  const build = w.publish('simc 1215-01', '1215-01')

  // null is what probeVersion returns when Windows blocks the file.
  const result = await installUpdate(build, { root: w.root, allowHttpHosts: LOCAL, probe: reports(null) })
  assert.equal(result.status, 'rolled back')
  assert.match(result.status === 'rolled back' ? result.reason : '', /did not start/)

  // Exactly as before: same active build, same rollback target, and the failed
  // build is neither installed nor anyone's previous.
  assert.deepEqual(
    { buildId: (await readActive(w.root))?.buildId, previous: (await readActive(w.root))?.previousBuildId },
    { buildId: before?.buildId, previous: before?.previousBuildId }
  )
  assert.deepEqual(await verifyBuild(w.root, before!.buildId), [])
  const builds = (await readdir(w.root)).filter((name) => !name.startsWith('.') && !name.endsWith('.json'))
  assert.deepEqual(builds, [before!.buildId], 'the failed build was left installed')
  assert.equal(await pickUpdate(w.root, { schema: 1, builds: [build] }), null, 'a failed build was offered again')
})

test('a build reporting a different version than approved is rolled back', async (t) => {
  const w = await world(t)
  const before = await readActive(w.root)
  const build = w.publish('simc 1215-01', '1215-01')
  const result = await installUpdate(build, { root: w.root, allowHttpHosts: LOCAL, probe: reports('1210-01') })
  assert.equal(result.status, 'rolled back')
  assert.match(result.status === 'rolled back' ? result.reason : '', /reported 1210-01, not 1215-01/)
  assert.equal((await readActive(w.root))?.buildId, before?.buildId)
})

test('rolling back restores an earlier rollback target too', async (t) => {
  const w = await world(t)
  // Two successful updates give a real active/previous chain to preserve.
  const first = w.publish('simc 1215-01', '1215-01')
  await installUpdate(first, { root: w.root, allowHttpHosts: LOCAL, probe: reports('1215-01') })
  const chain = await readActive(w.root)
  assert.ok(chain?.previousBuildId, 'setup did not produce a rollback target')

  const broken = w.publish('simc 1220-01', '1220-01')
  const result = await installUpdate(broken, { root: w.root, allowHttpHosts: LOCAL, probe: reports(null) })
  assert.equal(result.status, 'rolled back')
  const after = await readActive(w.root)
  assert.equal(after?.buildId, chain?.buildId)
  assert.equal(after?.previousBuildId, chain?.previousBuildId, 'the original rollback target was lost')
})

test('the download itself is checked, not only what it decompresses to', async (t) => {
  // Same simc.exe inside, different compressed bytes. Only the download
  // checksum can catch this, so it proves that check exists on its own rather
  // than hiding behind the simc.exe checksum. It matters because an untrusted
  // archive should never reach the decompressor at all.
  const w = await world(t)
  const before = await readActive(w.root)
  const build = w.publish('simc 1215-01', '1215-01')
  const recompressed = gzipSync(Buffer.from('simc 1215-01'), { level: zlibConstants.Z_NO_COMPRESSION })
  assert.notEqual(recompressed.toString('hex'), w.files.get(new URL(build.url).pathname)!.toString('hex'))
  w.files.set(new URL(build.url).pathname, recompressed)

  await assert.rejects(
    () => installUpdate({ ...build, gzSize: recompressed.length }, { root: w.root, allowHttpHosts: LOCAL, probe: reports('1215-01') }),
    /downloaded simc does not match the approved checksum/
  )
  assert.deepEqual(await readActive(w.root), before)
})
