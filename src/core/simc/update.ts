/**
 * Updating simc between SimItBoi releases, one click, no pop-ups.
 *
 * The chain of trust, from the only thing SimItBoi trusts outright:
 *
 * 1. A public key compiled into SimItBoi (`updateKey.ts`). Its private half is
 *    held by the maintainer and, as a secret, by the update workflow.
 * 2. A manifest listing published builds, signed with that private key. A
 *    manifest whose signature does not verify is ignored entirely, so a
 *    download host that serves different bytes cannot push an update; only
 *    the workflow holding the key can.
 * 3. Each build in the manifest carries the SHA-256 of its download and of the
 *    decompressed simc.exe. Both are checked before anything is installed.
 *
 * simulationcraft.org publishes Windows builds over plain HTTP with no
 * checksums, which is why the manifest exists at all: the hashes in it were
 * recorded once, by the update workflow, after the build ran on Windows.
 *
 * Installing reuses the build provisioning in `provision.ts` — staged, verified,
 * activated, previous build kept — and then runs the new simulator once. If it
 * fails to start (Smart App Control blocks unsigned files it has no reputation
 * for), or reports a different version than the manifest promised, the
 * previous build is restored and the failed one is removed and never offered
 * again.
 */
import { createHash, verify as verifySignature } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import {
  activateBuild, compareSimcVersions, exePath, listBuilds, readActive, readManifest, restoreActiveRecord,
  stageBuild, type BuildManifest
} from './provision.ts'

export const UPDATE_MANIFEST_SCHEMA = 1

/** Upper bounds, so a hostile or broken response cannot fill the disk. */
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_SIGNATURE_BYTES = 1024
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
/** simc.exe is about 115 MB; far above that means a decompression bomb. */
const MAX_EXE_BYTES = 400 * 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/

export interface UpdateBuild {
  /** simc's own version string, e.g. "1210-01". */
  version: string
  /** The simc git commit the build was made from. */
  commit: string
  /** HTTPS URL of the gzip-compressed simc.exe. */
  url: string
  gzSha256: string
  gzSize: number
  exeSha256: string
  exeSize: number
  /** When the update workflow approved it. */
  publishedAt: string
}

export interface UpdateManifest {
  schema: number
  /** Newest first. */
  builds: UpdateBuild[]
}

/**
 * Checks a manifest's shape. Called only on bytes whose signature has already
 * verified, but a signed manifest from a future schema is still refused rather
 * than read hopefully.
 */
export function validateManifest(value: unknown, allowHttpHosts: readonly string[] = []): UpdateManifest {
  const fail = (why: string): never => { throw new Error('Invalid simc update manifest: ' + why) }
  if (!value || typeof value !== 'object') fail('not an object')
  const manifest = value as Record<string, unknown>
  if (manifest.schema !== UPDATE_MANIFEST_SCHEMA) fail('unsupported schema ' + String(manifest.schema))
  if (!Array.isArray(manifest.builds)) fail('builds is not a list')
  const builds = manifest.builds as Array<Record<string, unknown>>
  builds.forEach((build, index) => {
    const at = 'build ' + index + ': '
    if (typeof build.version !== 'string' || compareSimcVersions(build.version, build.version) === null) fail(at + 'unreadable version')
    if (typeof build.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(build.commit)) fail(at + 'unreadable commit')
    if (typeof build.gzSha256 !== 'string' || !SHA256.test(build.gzSha256)) fail(at + 'bad gzSha256')
    if (typeof build.exeSha256 !== 'string' || !SHA256.test(build.exeSha256)) fail(at + 'bad exeSha256')
    for (const size of ['gzSize', 'exeSize'] as const) {
      if (!Number.isSafeInteger(build[size]) || (build[size] as number) <= 0) fail(at + 'bad ' + size)
    }
    if ((build.gzSize as number) > MAX_DOWNLOAD_BYTES) fail(at + 'download too large')
    if ((build.exeSize as number) > MAX_EXE_BYTES) fail(at + 'simc.exe too large')
    if (typeof build.publishedAt !== 'string' || Number.isNaN(Date.parse(build.publishedAt))) fail(at + 'bad publishedAt')
    let url: URL
    try { url = new URL(String(build.url)) } catch { return fail(at + 'bad url') }
    // A signed manifest is trusted, but a download over plain HTTP could still
    // be read or cut off in transit. Only tests serve over HTTP, from localhost.
    const insecureAllowed = url.protocol === 'http:' && allowHttpHosts.includes(url.hostname)
    if (url.protocol !== 'https:' && !insecureAllowed) fail(at + 'url is not https')
  })
  return manifest as unknown as UpdateManifest
}

/**
 * Verifies the manifest's Ed25519 signature over its exact bytes, then parses it.
 *
 * With no public key configured the updater is off: there is nothing to check a
 * signature against, and an unverified manifest is never used.
 */
export function readSignedManifest(
  bytes: Buffer,
  signatureBase64: string,
  publicKeyPem: string | null,
  allowHttpHosts: readonly string[] = []
): UpdateManifest {
  if (!publicKeyPem) throw new Error('simc updates are not configured: no update signing key is built into this copy of SimItBoi')
  const signature = Buffer.from(signatureBase64.trim(), 'base64')
  let valid = false
  try {
    valid = verifySignature(null, bytes, publicKeyPem, signature)
  } catch {
    valid = false
  }
  if (!valid) throw new Error('The simc update manifest signature is not valid; ignoring it')
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Invalid simc update manifest: not JSON') }
  return validateManifest(parsed, allowHttpHosts)
}

/** Builds that were installed, tested, and failed — never offered again. */
interface UpdateState { rejected: Record<string, string> }
const STATE_FILE = 'update-state.json'

async function readState(root: string): Promise<UpdateState> {
  try {
    const parsed = JSON.parse(await readFile(join(root, STATE_FILE), 'utf8')) as UpdateState
    return { rejected: parsed.rejected && typeof parsed.rejected === 'object' ? parsed.rejected : {} }
  } catch {
    return { rejected: {} }
  }
}

async function rejectBuild(root: string, exeSha256: string, reason: string): Promise<void> {
  const state = await readState(root)
  state.rejected[exeSha256] = reason
  await mkdir(root, { recursive: true })
  await writeFile(join(root, STATE_FILE), JSON.stringify(state, null, 2) + '\n', 'utf8')
}

/**
 * The build worth offering, or null.
 *
 * Only the newest build in the manifest is considered. It is not offered when
 * its simc.exe is already installed (active, or set aside on purpose), when it
 * previously failed its post-install test here, or when it is older than the
 * build in use — updates never downgrade.
 */
export async function pickUpdate(root: string, manifest: UpdateManifest): Promise<UpdateBuild | null> {
  const newest = manifest.builds[0]
  if (!newest) return null
  const installed = await listBuilds(root)
  if (installed.some((b) => Object.values(b.files).includes(newest.exeSha256))) return null
  if ((await readState(root)).rejected[newest.exeSha256]) return null
  const active = await readActive(root)
  const activeManifest = active ? await readManifest(root, active.buildId) : null
  const order = compareSimcVersions(newest.version, activeManifest?.version ?? null)
  if (order !== null && order < 0) return null
  return newest
}

export interface FetchedText { ok: boolean; status: number; body: Buffer }

/** Reads a response body with a byte cap, rather than trusting Content-Length. */
async function readCapped(response: Response, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  if (!response.body) return Buffer.alloc(0)
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > cap) throw new Error('Response exceeded ' + cap + ' bytes')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export type UpdateCheck =
  | { status: 'available'; build: UpdateBuild }
  | { status: 'current' }
  | { status: 'unconfigured' | 'unreachable' | 'invalid'; error: string }

export interface CheckOptions {
  /** Base URL holding `simc-manifest.json` and `simc-manifest.json.sig`. */
  manifestBaseUrl: string
  publicKeyPem: string | null
  root: string
  allowHttpHosts?: readonly string[]
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Wait before re-asking after a signature mismatch; tests shorten it. */
  retryDelayMs?: number
}

/**
 * Asks whether a newer approved simc exists. Never throws: being offline or
 * unconfigured is an ordinary state for a portable app, not an error to surface.
 */
export async function checkForUpdate(options: CheckOptions): Promise<UpdateCheck> {
  if (!options.publicKeyPem) {
    return { status: 'unconfigured', error: 'No update signing key is built into this copy of SimItBoi' }
  }
  const doFetch = options.fetchImpl ?? fetch
  const base = options.manifestBaseUrl.endsWith('/') ? options.manifestBaseUrl : options.manifestBaseUrl + '/'
  // The manifest and its signature are uploaded one after the other, so a check
  // landing between the two sees a mismatch that fixes itself. Ask once more
  // before calling it invalid.
  for (let attempt = 1; ; attempt++) {
    let manifestBytes: Buffer
    let signature: string
    try {
      const [manifestResponse, signatureResponse] = await Promise.all([
        doFetch(base + 'simc-manifest.json', { signal: options.signal }),
        doFetch(base + 'simc-manifest.json.sig', { signal: options.signal })
      ])
      if (!manifestResponse.ok || !signatureResponse.ok) {
        return { status: 'unreachable', error: 'Update server answered ' + manifestResponse.status + '/' + signatureResponse.status }
      }
      manifestBytes = await readCapped(manifestResponse, MAX_MANIFEST_BYTES)
      signature = (await readCapped(signatureResponse, MAX_SIGNATURE_BYTES)).toString('utf8')
    } catch (error) {
      return { status: 'unreachable', error: (error as Error).message }
    }
    let manifest: UpdateManifest
    try {
      manifest = readSignedManifest(manifestBytes, signature, options.publicKeyPem, options.allowHttpHosts)
    } catch (error) {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 5000))
        continue
      }
      return { status: 'invalid', error: (error as Error).message }
    }
    try {
      const build = await pickUpdate(options.root, manifest)
      return build ? { status: 'available', build } : { status: 'current' }
    } catch (error) {
      return { status: 'invalid', error: (error as Error).message }
    }
  }
}

export interface UpdateProgress {
  stage: 'downloading' | 'verifying' | 'installing' | 'testing' | 'rolling back'
  /** Download progress 0..1, where known. */
  fraction?: number
}

export interface InstallOptions {
  root: string
  allowHttpHosts?: readonly string[]
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  onProgress?: (progress: UpdateProgress) => void
  /**
   * Runs the freshly activated simulator once and reports its version. The app
   * passes `probeVersion`; tests pass a stand-in. Throwing or returning null
   * both count as the build failing to run.
   */
  probe: (exe: string, signal?: AbortSignal) => Promise<{ build: string } | null>
}

export type InstallResult =
  | { status: 'installed'; manifest: BuildManifest; previousBuildId: string | null }
  | { status: 'rolled back'; reason: string; activeBuildId: string | null }

/** Counts bytes through a stream and hashes them, refusing past a cap. */
function meter(cap: number, hash: ReturnType<typeof createHash>, onBytes?: (total: number) => void): Transform {
  let total = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength
      if (total > cap) { callback(new Error('Data exceeded ' + cap + ' bytes')); return }
      hash.update(chunk)
      onBytes?.(total)
      callback(null, chunk)
    }
  })
}

/**
 * Downloads, verifies, installs and tests one approved build.
 *
 * Nothing touches the build directory until both hashes match. The download
 * and decompression happen in a `.staging-` directory, which provisioning
 * already removes at startup, so an interrupted update leaves nothing behind.
 */
export async function installUpdate(build: UpdateBuild, options: InstallOptions): Promise<InstallResult> {
  validateManifest({ schema: UPDATE_MANIFEST_SCHEMA, builds: [build] }, options.allowHttpHosts)
  const doFetch = options.fetchImpl ?? fetch
  const progress = options.onProgress ?? (() => {})
  await mkdir(options.root, { recursive: true })
  const work = await mkdtemp(join(options.root, '.staging-update-'))
  try {
    // --- Download, hashing as it arrives --------------------------------
    progress({ stage: 'downloading', fraction: 0 })
    const response = await doFetch(build.url, { signal: options.signal, redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error('Download failed: HTTP ' + response.status)
    const gzPath = join(work, 'simc.exe.gz')
    const gzHash = createHash('sha256')
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      meter(Math.min(MAX_DOWNLOAD_BYTES, build.gzSize), gzHash,
        (total) => progress({ stage: 'downloading', fraction: Math.min(1, total / build.gzSize) })),
      createWriteStream(gzPath),
      { signal: options.signal }
    )
    progress({ stage: 'verifying' })
    if (gzHash.digest('hex') !== build.gzSha256) {
      throw new Error('The downloaded simc does not match the approved checksum; nothing was installed')
    }

    // --- Decompress, hashing the result ---------------------------------
    const exeDir = join(work, 'build')
    await mkdir(exeDir)
    const exeHash = createHash('sha256')
    await pipeline(
      createReadStream(gzPath),
      createGunzip(),
      meter(Math.min(MAX_EXE_BYTES, build.exeSize), exeHash),
      createWriteStream(join(exeDir, 'simc.exe')),
      { signal: options.signal }
    )
    if (exeHash.digest('hex') !== build.exeSha256) {
      throw new Error('The decompressed simc.exe does not match the approved checksum; nothing was installed')
    }

    // --- Install through the normal provisioning path --------------------
    progress({ stage: 'installing' })
    const before = await readActive(options.root)
    const staged = await stageBuild(options.root, {
      dir: exeDir, exe: 'simc.exe', version: build.version, source: build.url, include: ['simc.exe']
    }, options.signal)
    if (staged.manifest.files['simc.exe'] !== build.exeSha256) {
      throw new Error('The installed simc.exe does not match the approved checksum')
    }
    const manifest = await activateBuild(options.root, staged.manifest.buildId, options.signal)

    // --- Prove it runs here, or put everything back ----------------------
    progress({ stage: 'testing' })
    let failure: string | null = null
    try {
      const version = await options.probe(exePath(options.root, manifest), options.signal)
      if (!version) failure = 'the new simulator did not start — Windows may have blocked it'
      else if (version.build !== build.version) failure = 'the new simulator reported ' + version.build + ', not ' + build.version
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error
      failure = 'the new simulator failed to run: ' + (error as Error).message
    }
    if (failure === null) {
      return { status: 'installed', manifest, previousBuildId: before?.buildId ?? null }
    }

    progress({ stage: 'rolling back' })
    await restore(options.root, before)
    await rm(join(options.root, manifest.buildId), { recursive: true, force: true })
    await rejectBuild(options.root, build.exeSha256, failure)
    return { status: 'rolled back', reason: failure, activeBuildId: before?.buildId ?? null }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** Puts the active/previous pair back exactly as it was before a failed update. */
async function restore(root: string, before: Awaited<ReturnType<typeof readActive>>): Promise<void> {
  if (before) await restoreActiveRecord(root, before)
}
