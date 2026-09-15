/**
 * The weekly simc update, run by .github/workflows/simc-update.yml.
 *
 * Each run looks at the newest Windows nightly on simulationcraft.org. Nothing
 * is downloaded unless it carries a simc version newer than any already
 * mirrored or published; a new nightly under the same version is skipped.
 * `SIMC_UPDATE_ANY_NIGHTLY=1` lifts that, taking the newest nightly as it is.
 *
 * A new build is mirrored (a pre-release carrying simc.exe.gz and its GPL
 * license), proven to run, added to the manifest, signed with the key in
 * `SIMC_UPDATE_SIGNING_KEY`, and uploaded to the simc-channel release, where
 * every SimItBoi install finds it. No person needs to act. The decisions are in
 * scripts/lib/nightly.ts and are unit tested; this file performs them.
 *
 * `DRY_RUN=1` does the download, extraction, test run, packaging and signing
 * (when a key is present), then prints the GitHub commands instead of running
 * them.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import {
  CHANNEL_TAG, NIGHTLY_INDEX, addBuildToManifest, decide, extractFiles, parseNightlyIndex, parseReleaseNotes,
  pickLatest, releaseTag, renderReleaseNotes, type MirrorRecord
} from '../lib/nightly.ts'
import { signManifest } from '../lib/signing.ts'
import { probeVersion } from '../../src/core/simc/runner.ts'
import { readSignedManifest, UPDATE_MANIFEST_SCHEMA, type UpdateBuild, type UpdateManifest } from '../../src/core/simc/update.ts'
import { SIMC_UPDATE_PUBLIC_KEY } from '../../src/core/simc/updateKey.ts'

const DRY_RUN = process.env['DRY_RUN'] === '1'
const ANY_NIGHTLY = process.env['SIMC_UPDATE_ANY_NIGHTLY'] === '1'
const SIGNING_KEY = process.env['SIMC_UPDATE_SIGNING_KEY'] ?? ''
const REPOSITORY = process.env['GITHUB_REPOSITORY'] ?? 'arsamezzati/SimItBoi'
const SERVER = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com'
const CHANNEL_URL = SERVER + '/' + REPOSITORY + '/releases/download/' + CHANNEL_TAG + '/'

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Runs gh, or in a dry run prints what it would run. */
function gh(args: string[], options: { allowFailure?: boolean; mutates?: boolean } = {}): string | null {
  if (DRY_RUN && options.mutates) {
    console.log('[dry run] gh ' + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '))
    return ''
  }
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (options.allowFailure) return null
    throw error
  }
}

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error('GET ' + url + ' answered ' + response.status)
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(path))
}

/**
 * The manifest currently on the channel, or an empty one before the first
 * publish. An existing manifest must carry a valid signature: re-signing
 * whatever happens to be there would launder an edit made by anyone else.
 */
async function publishedManifest(work: string): Promise<UpdateManifest> {
  if (gh(['release', 'view', CHANNEL_TAG, '--repo', REPOSITORY, '--json', 'tagName'], { allowFailure: true }) === null) {
    return { schema: UPDATE_MANIFEST_SCHEMA, builds: [] }
  }
  const dir = join(work, 'channel')
  gh(['release', 'download', CHANNEL_TAG, '--repo', REPOSITORY, '--dir', dir,
    '--pattern', 'simc-manifest.json', '--pattern', 'simc-manifest.json.sig'])
  return readSignedManifest(
    await readFile(join(dir, 'simc-manifest.json')),
    await readFile(join(dir, 'simc-manifest.json.sig'), 'utf8'),
    SIMC_UPDATE_PUBLIC_KEY
  )
}

/** Adds a mirrored build to the manifest, signs it, and puts it on the channel. */
async function publish(mirrored: MirrorRecord, manifest: UpdateManifest, work: string): Promise<void> {
  const tag = 'simc-' + mirrored.version + '-' + mirrored.commit
  const url = SERVER + '/' + REPOSITORY + '/releases/download/' + tag + '/simc.exe.gz'

  // Sign for what users will actually download, not what we remember uploading.
  if (!DRY_RUN) {
    const published = join(work, 'published.gz')
    await download(url, published)
    if (await sha256File(published) !== mirrored.gzSha256) throw new Error('The published simc.exe.gz does not match its record')
  }

  const build: UpdateBuild = {
    version: mirrored.version, commit: mirrored.commit, url,
    gzSha256: mirrored.gzSha256, gzSize: mirrored.gzSize,
    exeSha256: mirrored.exeSha256, exeSize: mirrored.exeSize,
    publishedAt: new Date().toISOString()
  }
  const bytes = Buffer.from(addBuildToManifest(manifest, build), 'utf8')
  if (!SIGNING_KEY.trim()) {
    if (DRY_RUN) { console.log('[dry run] no signing key; would publish:\n' + bytes.toString('utf8')); return }
    throw new Error('SIMC_UPDATE_SIGNING_KEY is empty. Add the private key as a repository secret with that name.')
  }
  const signature = signManifest({ bytes, privateKeyPem: SIGNING_KEY, embeddedPublicKeyPem: SIMC_UPDATE_PUBLIC_KEY })

  const out = join(work, 'publish')
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'simc-manifest.json'), bytes)
  await writeFile(join(out, 'simc-manifest.json.sig'), signature)
  if (DRY_RUN) { console.log('[dry run] signed manifest:\n' + bytes.toString('utf8')) }

  if (gh(['release', 'view', CHANNEL_TAG, '--repo', REPOSITORY, '--json', 'tagName'], { allowFailure: true }) === null) {
    gh(['release', 'create', CHANNEL_TAG, '--repo', REPOSITORY, '--prerelease', '--title', 'simc update channel',
      '--notes', 'The signed list of simc builds SimItBoi offers as updates. Maintained by the simc update workflow; do not edit or delete.'],
    { mutates: true })
  }
  // Signature last: an app that catches the gap sees a signature that does not
  // match, and simply asks again.
  gh(['release', 'upload', CHANNEL_TAG, join(out, 'simc-manifest.json'), '--repo', REPOSITORY, '--clobber'], { mutates: true })
  gh(['release', 'upload', CHANNEL_TAG, join(out, 'simc-manifest.json.sig'), '--repo', REPOSITORY, '--clobber'], { mutates: true })
  if (DRY_RUN) return

  // Read it back the way SimItBoi will. Downloads can lag an upload briefly.
  for (let attempt = 1; ; attempt++) {
    try {
      const [m, s] = await Promise.all([
        fetch(CHANNEL_URL + 'simc-manifest.json').then(async (r) => Buffer.from(await r.arrayBuffer())),
        fetch(CHANNEL_URL + 'simc-manifest.json.sig').then(async (r) => await r.text())
      ])
      const live = readSignedManifest(m, s, SIMC_UPDATE_PUBLIC_KEY)
      if (live.builds[0]?.exeSha256 !== build.exeSha256) throw new Error('the channel does not list the new build first yet')
      break
    } catch (error) {
      if (attempt >= 6) throw new Error('The published channel does not verify: ' + (error as Error).message)
      await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
  }
  console.log('Published simc ' + build.version + ' (' + build.commit + '). Every SimItBoi install now offers it.')
}

const work = await mkdtemp(join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'simc-update-'))
try {
  // --- What is newest upstream, and what is already known ----------------
  const index = await fetch(NIGHTLY_INDEX + '?C=M;O=D')
  if (!index.ok) throw new Error('The nightly index answered ' + index.status)
  const latest = pickLatest(parseNightlyIndex(await index.text()))
  const tag = releaseTag(latest)
  console.log('Newest Windows nightly: ' + latest.file + ' (' + tag + ')')

  const manifest = await publishedManifest(work)
  const releases = gh(['release', 'list', '--repo', REPOSITORY, '--limit', '1000', '--json', 'tagName'])
  const releaseTags = (JSON.parse(releases || '[]') as Array<{ tagName: string }>).map((r) => r.tagName)
  const releaseJson = releaseTags.includes(tag)
    ? gh(['release', 'view', tag, '--repo', REPOSITORY, '--json', 'body'])
    : null
  const record = releaseJson ? parseReleaseNotes((JSON.parse(releaseJson) as { body: string }).body) : null

  const decision = decide({ latest, record, manifest, releaseTags, anyNightly: ANY_NIGHTLY })
  console.log('Decision: ' + JSON.stringify(decision))

  switch (decision.action) {
    case 'done':
      console.log('Nothing to do: ' + decision.reason + '.')
      break

    case 'publish':
      await publish(record!, manifest, work)
      break

    case 'mirror': {
      const archive = join(work, latest.file)
      await download(NIGHTLY_INDEX + latest.file, archive)
      const archiveSha256 = await sha256File(archive)
      console.log('Archive sha256 ' + archiveSha256 + ', ' + ((await stat(archive)).size / 1048576).toFixed(1) + ' MB')

      const out = join(work, 'out')
      await mkdir(out)
      extractFiles(archive, ['simc.exe', 'COPYING'], out)
      const exe = join(out, 'simc.exe')

      // Prove it runs and is the version its name claims, before anyone can
      // download it from us.
      const version = await probeVersion(exe)
      if (!version) throw new Error('The extracted simc.exe did not run')
      if (version.build !== latest.version) throw new Error('simc.exe reports ' + version.build + ' but the file name says ' + latest.version)

      const gz = join(out, 'simc.exe.gz')
      await pipeline(createReadStream(exe), createGzip({ level: 9 }), createWriteStream(gz))
      const mirrored: MirrorRecord = {
        version: latest.version, commit: latest.commit, sourceFile: latest.file,
        firstSeen: new Date().toISOString(), archiveSha256,
        exeSha256: await sha256File(exe), exeSize: (await stat(exe)).size,
        gzSha256: await sha256File(gz), gzSize: (await stat(gz)).size
      }
      const notes = join(work, 'notes.txt')
      await writeFile(notes, renderReleaseNotes(mirrored))
      console.log('Tested ' + version.build + '; simc.exe.gz is ' + (mirrored.gzSize / 1048576).toFixed(1) + ' MB')
      gh(['release', 'create', tag, gz, join(out, 'COPYING'), '--repo', REPOSITORY, '--prerelease',
        '--title', 'simc ' + latest.version + ' (' + latest.commit + ')', '--notes-file', notes], { mutates: true })
      console.log('Mirrored as pre-release ' + tag + '.')

      await publish(mirrored, manifest, work)
      break
    }
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
