/**
 * Atomic activation of a generated data set.
 *
 * A generator that writes its outputs one at a time into their live locations
 * has no safe failure point. `build-season-gear.ts` replaced season 1 before
 * season 2 had been computed, then dropped the live SQLite tables before
 * inserting into them, so a crash — or a Ctrl+C, or a network error fetching
 * icons — could leave season 1 from the new run beside season 2 from the old
 * one, or an empty database. Both look fine to anything that only checks a file
 * exists, and both produce wrong answers rather than errors.
 *
 * So: build everything into a staging directory, validate it there, then move
 * the finished set into place in one pass at the end. The live set is untouched
 * until every output exists and has been checked, and the previous generation is
 * kept so a bad set can be undone.
 *
 * This is the same shape as the simc build provisioning in
 * `src/core/simc/provision.ts`, for the same reason: a partially replaced
 * install is worse than a failed update.
 */
import { access, cp, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export interface Output {
  /** Where this output lives when active, relative to the repository root. */
  target: string
  /**
   * True for a directory of files that is added to rather than replaced, such
   * as the icon folder. Its staged contents are merged into the live directory
   * instead of replacing it, since icons accumulate across runs.
   */
  merge?: boolean
}

const exists = async (path: string): Promise<boolean> =>
  await access(path).then(() => true, () => false)

export class Generation {
  // Written out rather than declared as constructor parameter properties:
  // Node's type stripping does not support that syntax, and these scripts run
  // straight through node with no build step.
  readonly outputs: readonly Output[]
  private readonly staging: string
  private readonly previous: string
  private activated = false

  private constructor(outputs: readonly Output[], staging: string, previous: string) {
    this.outputs = outputs
    this.staging = staging
    this.previous = previous
  }

  static async open(outputs: readonly Output[], root = '.generation'): Promise<Generation> {
    await mkdir(root, { recursive: true })
    const staging = await mkdtemp(join(root, 'staging-'))
    return new Generation(outputs, staging, join(root, 'previous'))
  }

  /**
   * Where to write an output while building. Callers write here and nowhere
   * else; `activate` is what makes any of it visible.
   */
  async pathFor(target: string): Promise<string> {
    if (!this.outputs.some((o) => o.target === target)) {
      throw new Error(target + ' is not a declared output of this generation')
    }
    const staged = join(this.staging, target)
    await mkdir(dirname(staged), { recursive: true })
    return staged
  }

  /**
   * Seeds a staged output with the current live copy.
   *
   * For outputs that accumulate — the icon directory, the icon map — the new
   * generation starts from what is already there rather than from nothing.
   */
  async seed(target: string): Promise<string> {
    const staged = await this.pathFor(target)
    if (await exists(target)) await cp(target, staged, { recursive: true })
    return staged
  }

  /**
   * Every declared output must exist and be non-empty before anything moves.
   *
   * This is the check that makes the staging worthwhile: a generator that threw
   * halfway leaves an incomplete staging directory, and an incomplete set must
   * never reach the live one.
   */
  async validate(): Promise<void> {
    const missing: string[] = []
    for (const output of this.outputs) {
      const staged = join(this.staging, output.target)
      const info = await stat(staged).catch(() => null)
      if (!info) { missing.push(output.target + ' was never written'); continue }
      if (info.isDirectory()) {
        if ((await readdir(staged)).length === 0) missing.push(output.target + ' is an empty directory')
      } else if (info.size === 0) {
        missing.push(output.target + ' is empty')
      }
    }
    if (missing.length > 0) {
      throw new Error('This generation is incomplete and was not activated: ' + missing.join('; '))
    }
  }

  /**
   * Moves the finished set into place, keeping the one it replaces.
   *
   * Renames cannot be made atomic across several files, but the window is now
   * the few milliseconds of the renames themselves rather than the minutes of
   * fetching and parsing that produced them — and every output is known to
   * exist before the first one moves.
   */
  async activate(): Promise<void> {
    await this.validate()
    await rm(this.previous, { recursive: true, force: true })
    await mkdir(this.previous, { recursive: true })

    for (const output of this.outputs) {
      const staged = join(this.staging, output.target)
      if (await exists(output.target)) {
        const kept = join(this.previous, output.target)
        await mkdir(dirname(kept), { recursive: true })
        await cp(output.target, kept, { recursive: true })
      }
      await mkdir(dirname(resolve(output.target)), { recursive: true })
      if (output.merge) {
        // Accumulating directories are merged, so files an earlier run
        // downloaded are not lost because this run did not need them.
        await cp(staged, output.target, { recursive: true, force: true })
      } else {
        await rm(output.target, { recursive: true, force: true })
        await rename(staged, output.target)
      }
    }
    this.activated = true
    await rm(this.staging, { recursive: true, force: true })
  }

  /** Throws away an unfinished generation, leaving the live set untouched. */
  async discard(): Promise<void> {
    if (this.activated) return
    await rm(this.staging, { recursive: true, force: true })
  }

  /** Puts the previous generation back, for when a new one turns out to be wrong. */
  async rollback(): Promise<void> {
    if (!(await exists(this.previous))) throw new Error('There is no previous generation to restore')
    for (const output of this.outputs) {
      const kept = join(this.previous, output.target)
      if (!(await exists(kept))) continue
      await rm(output.target, { recursive: true, force: true })
      await mkdir(dirname(resolve(output.target)), { recursive: true })
      await cp(kept, output.target, { recursive: true })
    }
  }
}
