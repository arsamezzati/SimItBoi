/**
 * The public half of the simc update signing key.
 *
 * SimItBoi only installs simulator updates listed in a manifest signed by the
 * matching private key, which stays on the maintainer's own machine. While this
 * is null the updater is switched off: nothing is checked, downloaded or
 * offered.
 *
 * Do not edit by hand. `npm run simc-update:keygen` generates the key pair,
 * stores the private key outside the repository, and writes the public key
 * here.
 */
export const SIMC_UPDATE_PUBLIC_KEY: string | null = null

/**
 * Where approved builds are listed. Served over HTTPS from this repository
 * once it is public; `SIMITBOI_SIMC_UPDATE_URL` overrides it in development.
 */
export const SIMC_UPDATE_MANIFEST_BASE_URL =
  'https://raw.githubusercontent.com/arsamezzati/SimItBoi/main/update/'
