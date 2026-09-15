import type { Profile } from '../types.ts'
import { compareSimcBuild, type SimcVersion } from './runner.ts'

export function requireCompatibleSimc(profile: Profile, version: SimcVersion): void {
  const required = profile.header.requiresSimcBuild
  if (required && compareSimcBuild(version.build, required) < 0) {
    throw new Error(`Profile requires simc ${required}; installed build is ${version.build}.`)
  }
}
