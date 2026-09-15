import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generateSigningKey, signManifest } from '../scripts/lib/signing.ts'
import { UPDATE_MANIFEST_SCHEMA, readSignedManifest } from '../src/core/simc/update.ts'

/**
 * The signing key and the signatures made with it.
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
  await mkdir(repo, { recursive: true })
  await mkdir(home)
  const keyModulePath = join(repo, 'updateKey.ts')
  await writeFile(keyModulePath, KEY_MODULE)
  return { repo, home, keyModulePath, privateKeyPath: join(home, '.simitboi', 'signing.pem') }
}

/** Imports the rewritten key module the way SimItBoi would, to prove it still compiles and loads. */
async function loadKey(path: string): Promise<string | null> {
  const copy = path.replace(/\.ts$/, '.loaded-' + Date.now() + '.ts')
  await writeFile(copy, await readFile(path, 'utf8'))
  return ((await import(pathToFileURL(copy).href)) as { SIMC_UPDATE_PUBLIC_KEY: string | null }).SIMC_UPDATE_PUBLIC_KEY
}

/** A key pair as the maintainer has it: private key file, public key built in. */
async function maintainer(t: { after: (fn: () => unknown) => void }) {
  const l = await layout(t)
  await generateSigningKey({ privateKeyPath: l.privateKeyPath, repoRoot: l.repo, keyModulePath: l.keyModulePath })
  return { ...l, privateKeyPem: await readFile(l.privateKeyPath, 'utf8'), embedded: await loadKey(l.keyModulePath) }
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
  const m = await maintainer(t)
  const bytes = Buffer.from(MANIFEST)
  const signature = signManifest({ bytes, privateKeyPem: m.privateKeyPem, embeddedPublicKeyPem: m.embedded })
  assert.equal(readSignedManifest(bytes, signature, m.embedded).builds[0]!.version, '1210-01')
})

test('signing with a key SimItBoi does not carry is refused', async (t) => {
  const m = await maintainer(t)
  // A second key pair, e.g. a secret pasted from the wrong file.
  const other = await maintainer(t)
  assert.throws(
    () => signManifest({ bytes: Buffer.from(MANIFEST), privateKeyPem: other.privateKeyPem, embeddedPublicKeyPem: m.embedded }),
    /does not match the public key built into SimItBoi/
  )
})

test('a secret that is not a private key is refused plainly', async (t) => {
  const m = await maintainer(t)
  assert.throws(
    () => signManifest({ bytes: Buffer.from(MANIFEST), privateKeyPem: 'paste went wrong', embeddedPublicKeyPem: m.embedded }),
    /not a readable private key/
  )
})

test('signing is refused before any key is built in', async (t) => {
  const m = await maintainer(t)
  assert.throws(
    () => signManifest({ bytes: Buffer.from(MANIFEST), privateKeyPem: m.privateKeyPem, embeddedPublicKeyPem: null }),
    /no update public key built in/
  )
})

test('a manifest SimItBoi would refuse is not signed', async (t) => {
  const m = await maintainer(t)
  assert.throws(
    () => signManifest({
      bytes: Buffer.from(MANIFEST.replace('https://example.invalid', 'http://example.invalid')),
      privateKeyPem: m.privateKeyPem, embeddedPublicKeyPem: m.embedded
    }),
    /not https/
  )
})
