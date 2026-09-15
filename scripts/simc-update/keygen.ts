/**
 * One-time setup for simc updates: `npm run simc-update:keygen`.
 *
 * Creates the signing key pair, stores the private key in your user profile
 * (never in the repository), and builds the public key into SimItBoi. Run it
 * once, on your own machine, then commit the change to updateKey.ts.
 *
 * Optional: `npm run simc-update:keygen -- <path to private key>`.
 */
import { resolve } from 'node:path'
import { defaultPrivateKeyPath, generateSigningKey } from '../lib/signing.ts'

const privateKeyPath = resolve(process.argv[2] ?? defaultPrivateKeyPath())
const result = await generateSigningKey({
  privateKeyPath,
  repoRoot: process.cwd(),
  keyModulePath: resolve('src/core/simc/updateKey.ts')
})

console.log('Private signing key written to:')
console.log('  ' + result.privateKeyPath)
console.log('')
console.log('Keep it safe and back it up somewhere offline. Anyone holding it can approve a')
console.log('simulator for every SimItBoi install, and losing it means shipping a new SimItBoi')
console.log('release before updates work again.')
console.log('')
console.log('The public key is now built into src/core/simc/updateKey.ts — commit that file.')
