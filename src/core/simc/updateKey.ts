/**
 * The public half of the simc update signing key.
 *
 * SimItBoi only installs simulator updates listed in a manifest signed by the
 * matching private key, which lives in the maintainer's profile and in the
 * update workflow's secrets. While this is null the updater is switched off:
 * nothing is checked, downloaded or offered.
 *
 * Do not edit by hand. `npm run simc-update:keygen` generates the key pair,
 * stores the private key outside the repository, and writes the public key
 * here.
 */
export const SIMC_UPDATE_PUBLIC_KEY: string | null = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAE3iWsYbGWtqFaSj/Cf+A2K5uFKPp14gnKfTYHr1u/0Q=\n-----END PUBLIC KEY-----\n"

/**
 * Where published builds are listed: the assets of the simc-channel release,
 * which the update workflow maintains. `SIMITBOI_SIMC_UPDATE_URL` overrides it
 * in development.
 */
export const SIMC_UPDATE_MANIFEST_BASE_URL =
  'https://github.com/arsamezzati/SimItBoi/releases/download/simc-channel/'
