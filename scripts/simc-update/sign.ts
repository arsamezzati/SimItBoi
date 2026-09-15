/**
 * Approves the simc builds listed in update/simc-manifest.json:
 * `npm run simc-update:sign`.
 *
 * Run it on your own machine after reviewing the update workflow's pull
 * request, then commit update/simc-manifest.json.sig to that pull request and
 * merge. Until the signature is committed, SimItBoi ignores the manifest.
 *
 * Optional: `npm run simc-update:sign -- <path to private key>`.
 */
import { resolve } from 'node:path'
import { defaultPrivateKeyPath, signManifest } from '../lib/signing.ts'
import { SIMC_UPDATE_PUBLIC_KEY } from '../../src/core/simc/updateKey.ts'

const { signaturePath } = await signManifest({
  manifestPath: resolve('update/simc-manifest.json'),
  privateKeyPath: resolve(process.argv[2] ?? defaultPrivateKeyPath()),
  embeddedPublicKeyPem: SIMC_UPDATE_PUBLIC_KEY
})
console.log('Signed. Commit ' + signaturePath + ' to the update pull request, then merge it.')
