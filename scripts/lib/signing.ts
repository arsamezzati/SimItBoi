/**
 * Signing keys and manifest signatures for simc updates.
 *
 * The private key is the one thing that can approve a simulator for every
 * SimItBoi install, so these functions are deliberately stubborn about where it
 * lives: never inside the repository, never overwritten, and never used to
 * produce a signature the built-in public key would not accept. Its only other
 * copy is the SIMC_UPDATE_SIGNING_KEY secret the update workflow signs with.
 */
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { validateManifest } from '../../src/core/simc/update.ts'

/** Outside any repository by default, in the maintainer's own profile. */
export function defaultPrivateKeyPath(): string {
  return join(homedir(), '.simitboi', 'simc-update-signing.pem')
}

const exists = async (path: string): Promise<boolean> => await access(path).then(() => true, () => false)

/** True when `path` is `root` or anywhere beneath it. */
function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  // A path on another drive comes back absolute from relative(), and is not inside.
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface KeygenResult { privateKeyPath: string; publicKeyPem: string }

/**
 * Creates the signing key pair and builds its public half into SimItBoi.
 *
 * Refuses to overwrite an existing private key: every manifest ever published
 * was signed with it, and every released copy of SimItBoi checks against it, so
 * replacing it by accident would silently switch updates off for all of them.
 */
export async function generateSigningKey(options: {
  privateKeyPath: string
  repoRoot: string
  keyModulePath: string
}): Promise<KeygenResult> {
  if (isInside(options.repoRoot, options.privateKeyPath)) {
    throw new Error('Refusing to store the private signing key inside the repository: ' + options.privateKeyPath)
  }
  if (await exists(options.privateKeyPath)) {
    throw new Error(
      'A signing key already exists at ' + options.privateKeyPath + '. Replacing it would stop every ' +
      'released SimItBoi from accepting updates. Move it aside yourself if you really mean to.'
    )
  }
  const pair = generateKeyPairSync('ed25519')
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()

  await mkdir(dirname(options.privateKeyPath), { recursive: true })
  // 0o600: readable only by the account that made it, where the OS honours it.
  await writeFile(options.privateKeyPath, privateKeyPem, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await writePublicKey(options.keyModulePath, publicKeyPem)
  return { privateKeyPath: options.privateKeyPath, publicKeyPem }
}

const KEY_DECLARATION = /export const SIMC_UPDATE_PUBLIC_KEY: string \| null = [^\n]*\n/

/** Replaces the public key constant, leaving the rest of the module alone. */
export async function writePublicKey(keyModulePath: string, publicKeyPem: string): Promise<void> {
  const source = await readFile(keyModulePath, 'utf8')
  if (!KEY_DECLARATION.test(source)) throw new Error('Could not find SIMC_UPDATE_PUBLIC_KEY in ' + keyModulePath)
  // JSON.stringify gives a valid single-line TypeScript string with the PEM's
  // line breaks escaped, so nothing about the key can break the module.
  const replacement = 'export const SIMC_UPDATE_PUBLIC_KEY: string | null = ' + JSON.stringify(publicKeyPem) + '\n'
  await writeFile(keyModulePath, source.replace(KEY_DECLARATION, replacement), 'utf8')
}

/**
 * Signs manifest bytes and proves the signature before returning it.
 *
 * The update workflow calls this with the key from its secrets. The check
 * against the built-in public key catches the mistakes that would otherwise
 * only surface as "no updates, for no visible reason" on users' machines:
 * a secret holding the wrong key, or a public key never built into SimItBoi.
 *
 * Returns the signature as base64 text, the form SimItBoi downloads.
 */
export function signManifest(options: {
  bytes: Buffer
  privateKeyPem: string
  embeddedPublicKeyPem: string | null
}): string {
  if (!options.embeddedPublicKeyPem) {
    throw new Error('SimItBoi has no update public key built in yet. Run `npm run simc-update:keygen` first.')
  }
  const { bytes } = options
  // A manifest that SimItBoi would refuse is not worth signing.
  validateManifest(JSON.parse(bytes.toString('utf8')))
  let signature: Buffer
  try {
    signature = sign(null, bytes, options.privateKeyPem)
  } catch {
    throw new Error('The signing key is not a readable private key. Nothing was signed.')
  }
  if (!verify(null, bytes, options.embeddedPublicKeyPem, signature)) {
    throw new Error('The signing key does not match the public key built into SimItBoi. Nothing was signed; users would reject this signature.')
  }
  return signature.toString('base64') + '\n'
}
