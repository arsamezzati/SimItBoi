/**
 * One-time setup for simc updates: `npm run simc-update:keygen`.
 *
 * Creates the signing key pair, stores the private key in your user profile
 * (never in the repository), and builds the public key into SimItBoi. Run it
 * once, on your own machine, then commit the change to updateKey.ts and add the
 * private key to the repository as the SIMC_UPDATE_SIGNING_KEY secret.
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
console.log('1. Commit src/core/simc/updateKey.ts, which now carries the public key.')
console.log('2. On GitHub: Settings > Secrets and variables > Actions > New repository secret.')
console.log('   Name it SIMC_UPDATE_SIGNING_KEY and paste the whole private key file as the value.')
console.log('3. Back the file up somewhere offline. Losing it means shipping a new SimItBoi')
console.log('   release before updates work again.')
