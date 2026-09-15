import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verify } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateSigningKey, signManifest } from '../scripts/lib/signing.ts'
import { UPDATE_MANIFEST_SCHEMA, readSignedManifest } from '../src/core/simc/update.ts'

/**
 * The maintainer's signing tools.
 *
 * The private key can approve a simulator for every SimItBoi install, so the
 * tests here are mostly about the ways it could end up somewhere it should not,
 * be lost, or produce a signature that users would silently reject.
 */

const KEY_MODULE = [
  '/** header */',
  'export const SIMC_UPDATE_PUBLIC_KEY: string | null = null',
  '',
  "export const SIMC_UPDATE_MANIFEST_BASE_URL = 'https://example.invalid/update/'",
  ''
].join('\n')

const MANIFEST = JSON.stringify({
  schema: UPDATE_MANIFEST_SCHEMA,
  builds: [{
    version: '1210-01', commit: 'c1935b9', url: 'https://example.invalid/simc.exe.gz',
    gzSha256: 'a'.repeat(64), gzSize: 100, exeSha256: 'b'.repeat(64), exeSize: 1000,
    publishedAt: '2026-09-15T00:00:00Z'
  }]
}, null, 2)

async function layout(t: { after: (fn: () => unknown) => void }) {
  const base = await mkdtemp(join(tmpdir(), 'simitboi-signing-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const repo = join(base, 'repo')
  const home = join(base, 'home')
  await mkdir(join(repo, 'update'), { recursive: true })
  await mkdir(home)
  const keyModulePath = join(repo, 'updateKey.ts')
  await writeFile(keyModulePath, KEY_MODULE)
  const manifestPath = join(repo, 'update', 'simc-manifest.json')
  await writeFile(manifestPath, MANIFEST)
  return { repo, home, keyModulePath, manifestPath, privateKeyPath: join(home, '.simitboi', 'signing.pem') }
}

/** Imports the rewritten key module the way SimItBoi would, to prove it still compiles and loads. */
async function loadKey(path: string): Promise<string | null> {
  const copy = path.replace(/\.ts$/, '.loaded-' + Date.now() + '.ts')
  await writeFile(copy, await readFile(path, 'utf8'))
  return ((await import(pathToFileURL(copy).href)) as { SIMC_UPDATE_PUBLIC_KEY: string | null }).SIMC_UPDATE_PUBLIC_KEY
}

test('keygen stores the private key outside the repo and builds the public key in', async (t) => {
  const l = await layout(t)
  const result = await generateSigningKey({ privateKeyPath: l.privateKeyPath, repoRoot: l.repo, keyModulePath: l.keyModulePath })

  assert.match(await readFile(l.privateKeyPath, 'utf8'), /BEGIN PRIVATE KEY/)
  const embedded = await loadKey(l.keyModulePath)
  assert.equal(embedded, result.publicKeyPem, 'the module does not carry the generated public key')
  assert.match(embedded ?? '', /BEGIN PUBLIC KEY/)
  // The rest of the module is untouched.
  assert.match(await readFile(l.keyModulePath, 'utf8'), /SIMC_UPDATE_MANIFEST_BASE_URL = 'https:\/\/example\.invalid\/update\/'/)
})

test('keygen refuses to put the private key inside the repository', async (t) => {
  const l = await layout(t)
  await assert.rejects(
    () => generateSigningKey({ privateKeyPath: join(l.repo, 'keys', 'signing.pem'), repoRoot: l.repo, keyModulePath: l.keyModulePath }),
    /inside the repository/
  )
  assert.equal(await loadKey(l.keyModulePath), null, 'a public key was written despite the refusal')
})

test('keygen never overwrites an existing private key', async (t) => {
  const l = await layout(t)
  await generateSigningKey({ privateKeyPath: l.privateKeyPath, repoRoot: l.repo, keyModulePath: l.keyModulePath })
  const original = await readFile(l.privateKeyPath, 'utf8')
  const embedded = await readFile(l.keyModulePath, 'utf8')

  await assert.rejects(
    () => generateSigningKey({ privateKeyPath: l.privateKeyPath, repoRoot: l.repo, keyModulePath: l.keyModulePath }),
    /already exists/
  )
  assert.equal(await readFile(l.privateKeyPath, 'utf8'), original, 'the private key was replaced')
  assert.equal(await readFile(l.keyModulePath, 'utf8'), embedded, 'the built-in public key was replaced')
})

test('a signed manifest verifies with the built-in key, as SimItBoi checks it', async (t) => {
  const l = await layout(t)
  await generateSigningKey({ privateKeyPath: l.privateKeyPath, repoRoot: l.repo, keyModulePath: l.keyModulePath })
  const embedded = await loadKey(l.keyModulePath)
  const { signaturePath } = await signManifest({ manifestPath: l.manifestPath, privateKeyPath: l.privateKeyPath, embeddedPublicKeyPem: embedded })

  const bytes = await readFile(l.manifestPath)
  const signature = await readFile(signaturePath, 'utf8')
  assert.equal(readSignedManifest(bytes, signature, embedded).builds[0]!.version, '1210-01')
  assert.ok(verify(null, bytes, embedded!, Buffer.from(signature.trim(), 'base64')))
})

test('signing with a key SimItBoi does not carry is refused, and writes nothing', async (t) => {
  const l = await layout(t)
  await generateSigningKey({ privateKeyPath: l.privateKeyPath, repoRoot: l.repo, keyModulePath: l.keyModulePath })
  const embedded = await loadKey(l.keyModulePath)

  // A second key pair, e.g. generated on another machine by mistake.
  const other = await layout(t)
  await generateSigningKey({ privateKeyPath: other.privateKeyPath, repoRoot: other.repo, keyModulePath: other.keyModulePath })

  await assert.rejects(
    () => signManifest({ manifestPath: l.manifestPath, privateKeyPath: other.privateKeyPath, embeddedPublicKeyPem: embedded }),
    /does not match the public key built into SimItBoi/
  )
  await assert.rejects(() => stat(l.manifestPath + '.sig'), /ENOENT/)
})

test('signing is refused before any key is built in', async (t) => {
  const l = await layout(t)
  await assert.rejects(
    () => signManifest({ manifestPath: l.manifestPath, privateKeyPath: l.privateKeyPath, embeddedPublicKeyPem: null }),
    /no update public key built in/
  )
})

test('a manifest SimItBoi would refuse is not signed', async (t) => {
  const l = await layout(t)
  await generateSigningKey({ privateKeyPath: l.privateKeyPath, repoRoot: l.repo, keyModulePath: l.keyModulePath })
  const embedded = await loadKey(l.keyModulePath)
  await writeFile(l.manifestPath, MANIFEST.replace('https://example.invalid', 'http://example.invalid'))
  await assert.rejects(
    () => signManifest({ manifestPath: l.manifestPath, privateKeyPath: l.privateKeyPath, embeddedPublicKeyPem: embedded }),
    /not https/
  )
})

test('a manifest with Windows line endings is refused, since users download the LF file', async (t) => {
  const l = await layout(t)
  await generateSigningKey({ privateKeyPath: l.privateKeyPath, repoRoot: l.repo, keyModulePath: l.keyModulePath })
  const embedded = await loadKey(l.keyModulePath)
  await writeFile(l.manifestPath, MANIFEST.split('\n').join('\r\n'))
  await assert.rejects(
    () => signManifest({ manifestPath: l.manifestPath, privateKeyPath: l.privateKeyPath, embeddedPublicKeyPem: embedded }),
    /Windows line endings/
  )
  await assert.rejects(() => stat(l.manifestPath + '.sig'), /ENOENT/)
})
