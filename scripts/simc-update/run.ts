/**
 * The weekly simc mirror, run by .github/workflows/simc-update.yml.
 *
 * Each run looks at the newest Windows nightly on simulationcraft.org. Nothing
 * is downloaded unless it carries a simc version newer than any already
 * mirrored or approved; a new nightly under the same version is skipped.
 * `SIMC_UPDATE_ANY_NIGHTLY=1` lifts that, taking the newest nightly as it is.
 *
 * A build not seen before is mirrored (a pre-release carrying simc.exe.gz and
 * its GPL license) and proposed in a pull request adding it to the manifest. A
 * build already mirrored is re-hashed, and the run stops if its bytes changed.
 * The decisions themselves are in scripts/lib/nightly.ts and are unit tested;
 * this file performs them.
 *
 * It never signs anything. A proposed build reaches users only after the
 * maintainer runs `npm run simc-update:sign` on their own machine and merges.
 *
 * `SIMC_UPDATE_MIN_AGE_DAYS` adds a waiting period between mirroring and
 * proposing; it defaults to 0. `DRY_RUN=1` does the download, extraction, test
 * run and packaging, then prints the GitHub commands instead of running them.
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
  NIGHTLY_INDEX, addBuildToManifest, decide, extractFiles, isNewVersion, newestKnownVersion, parseNightlyIndex,
  parseReleaseNotes, pickLatest, releaseTag, renderReleaseNotes, type MirrorRecord
} from '../lib/nightly.ts'
import { probeVersion } from '../../src/core/simc/runner.ts'
import type { UpdateBuild, UpdateManifest } from '../../src/core/simc/update.ts'

const DRY_RUN = process.env['DRY_RUN'] === '1'
const MIN_AGE_DAYS = Number(process.env['SIMC_UPDATE_MIN_AGE_DAYS'] ?? 0)
const ANY_NIGHTLY = process.env['SIMC_UPDATE_ANY_NIGHTLY'] === '1'
const REPOSITORY = process.env['GITHUB_REPOSITORY'] ?? 'arsamezzati/SimItBoi'
const SERVER = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com'
const MANIFEST_PATH = 'update/simc-manifest.json'

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

function git(args: string[]): void {
  if (DRY_RUN) { console.log('[dry run] git ' + args.join(' ')); return }
  execFileSync('git', args, { stdio: 'inherit' })
}

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error('GET ' + url + ' answered ' + response.status)
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(path))
}

/**
 * Opens the pull request adding a mirrored build to the manifest. SimItBoi still
 * ignores it until the maintainer signs the manifest and merges.
 */
async function propose(mirrored: MirrorRecord, work: string): Promise<void> {
  const tag = 'simc-' + mirrored.version + '-' + mirrored.commit
  const branch = 'simc-update/' + tag
  const url = SERVER + '/' + REPOSITORY + '/releases/download/' + tag + '/simc.exe.gz'

  // Check what users will actually download, not what we remember uploading.
  if (!DRY_RUN) {
    const published = join(work, 'published.gz')
    await download(url, published)
    if (await sha256File(published) !== mirrored.gzSha256) throw new Error('The published simc.exe.gz does not match its record')
  }

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as UpdateManifest
  const build: UpdateBuild = {
    version: mirrored.version, commit: mirrored.commit, url,
    gzSha256: mirrored.gzSha256, gzSize: mirrored.gzSize,
    exeSha256: mirrored.exeSha256, exeSize: mirrored.exeSize,
    publishedAt: new Date().toISOString()
  }
  const next = addBuildToManifest(manifest, build)
  if (DRY_RUN) { console.log('[dry run] would write ' + MANIFEST_PATH + ':\n' + next); return }

  git(['config', 'user.name', 'github-actions[bot]'])
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  git(['checkout', '-b', branch])
  await writeFile(MANIFEST_PATH, next)
  git(['add', MANIFEST_PATH])
  // The old signature covers the old manifest. Removing it makes the unsigned
  // state obvious instead of leaving a signature that fails.
  git(['rm', '--quiet', '--ignore-unmatch', MANIFEST_PATH + '.sig'])
  git(['commit', '-m', 'Propose simc ' + mirrored.version + ' (' + mirrored.commit + ')'])
  git(['push', '--force', 'origin', branch])
  gh(['pr', 'create', '--repo', REPOSITORY, '--head', branch,
    '--title', 'simc update: ' + mirrored.version + ' (' + mirrored.commit + ')',
    '--body', [
      'simc ' + mirrored.version + ' (commit ' + mirrored.commit + ') is the newest Windows nightly.',
      'It ran successfully on a Windows runner before being published.',
      '',
      '- Release: ' + SERVER + '/' + REPOSITORY + '/releases/tag/' + tag,
      '- Source: https://github.com/simulationcraft/simc/tree/' + mirrored.commit,
      '- simc.exe sha256: `' + mirrored.exeSha256 + '`',
      '',
      '**SimItBoi ignores this manifest until it is signed.** To approve:',
      '',
      '```',
      'git fetch origin ' + branch + ' && git checkout ' + branch,
      'npm run simc-update:sign',
      'git add update/simc-manifest.json.sig && git commit -m "Sign simc ' + mirrored.version + '" && git push',
      '```',
      '',
      'Then merge. Every SimItBoi install offers the update on its next check.'
    ].join('\n')], { mutates: true })
}

const work = await mkdtemp(join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'simc-update-'))
try {
  // --- What is newest upstream ------------------------------------------
  const index = await fetch(NIGHTLY_INDEX + '?C=M;O=D')
  if (!index.ok) throw new Error('The nightly index answered ' + index.status)
  const latest = pickLatest(parseNightlyIndex(await index.text()))
  const tag = releaseTag(latest)
  console.log('Newest Windows nightly: ' + latest.file + ' (' + tag + ')')

  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as UpdateManifest
  const releases = gh(['release', 'list', '--repo', REPOSITORY, '--limit', '1000', '--json', 'tagName'], { allowFailure: true })
  const releaseTags = (JSON.parse(releases || '[]') as Array<{ tagName: string }>).map((r) => r.tagName)
  const known = newestKnownVersion(releaseTags, manifest)
  const alreadyMirrored = releaseTags.includes(tag)
  if (!ANY_NIGHTLY && !alreadyMirrored && !isNewVersion(latest, known)) {
    console.log('Nothing to do: simc ' + latest.version + ' is not newer than ' + known + '. Run with "any nightly" to take it anyway.')
    await rm(work, { recursive: true, force: true })
    process.exit(0)
  }

  const archive = join(work, latest.file)
  await download(NIGHTLY_INDEX + latest.file, archive)
  const archiveSha256 = await sha256File(archive)
  console.log('Archive sha256 ' + archiveSha256 + ', ' + ((await stat(archive)).size / 1048576).toFixed(1) + ' MB')

  // --- What we already know about it -------------------------------------
  const releaseJson = gh(['release', 'view', tag, '--repo', REPOSITORY, '--json', 'body'], { allowFailure: true })
  const record = releaseJson ? parseReleaseNotes((JSON.parse(releaseJson) as { body: string }).body) : null
  const openPulls = gh(['pr', 'list', '--repo', REPOSITORY, '--head', 'simc-update/' + tag, '--state', 'open', '--json', 'number'], { allowFailure: true })
  const pullRequestOpen = openPulls !== null && (JSON.parse(openPulls || '[]') as unknown[]).length > 0

  const decision = decide({ record, archiveSha256, manifest, pullRequestOpen, now: new Date(), minAgeDays: MIN_AGE_DAYS })
  console.log('Decision: ' + JSON.stringify(decision))

  switch (decision.action) {
    case 'tampered':
      // Failing the run makes GitHub notify the maintainer. Nothing is published.
      console.error(
        'The bytes behind ' + latest.file + ' changed since it was mirrored.\n' +
        '  recorded ' + decision.recorded + '\n  today    ' + decision.now + '\n' +
        'simulationcraft.org serves these over plain HTTP. Do not approve this build until you know why.'
      )
      process.exitCode = 1
      break

    case 'mirror': {
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

      // No waiting period: propose it in this run rather than the next.
      if (MIN_AGE_DAYS <= 0) await propose(mirrored, work)
      else console.log('It can be proposed in ' + MIN_AGE_DAYS + ' days if it stays the newest.')
      break
    }

    case 'wait':
      console.log(tag + ' is mirrored; ' + decision.daysLeft + ' more day(s) before it is proposed.')
      break

    case 'promote':
      await propose(record!, work)
      break

    case 'done':
      console.log('Nothing to do: ' + decision.reason + '.')
      break
  }
} finally {
  await rm(work, { recursive: true, force: true })
}
