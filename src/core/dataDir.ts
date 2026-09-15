/**
 * Where SimItBoi keeps everything mutable.
 *
 * The app is portable: `data/` sits beside the executable, so deleting the
 * folder removes every trace and zipping it hands the whole thing to someone
 * else. That only works where the folder is actually writable, and someone will
 * put this in Program Files, on a read-only stick, or on a network share.
 *
 * Split out of the main process so the fallback can be tested directly. Deciding
 * where to write is exactly the kind of thing that is only ever exercised on a
 * machine you do not own.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface DataDirChoice {
  dir: string
  /** True for a packaged app, whether or not the portable folder was usable. */
  portable: boolean
  /** True when the folder beside the executable could not be written to. */
  fellBack: boolean
  /** Why the portable folder was rejected, for the UI and the log. */
  reason: string | null
}

/**
 * Proves a directory is writable by writing to it.
 *
 * `access(W_OK)` is not enough and this is not hypothetical: on Windows it
 * consults the read-only attribute and basic ACLs, and answers "yes" for
 * directories a write still fails in — virtualised Program Files, a full disk,
 * a network share that refuses creates, a folder denied by an inherited ACL the
 * check does not model. Writing a file, reading it back and deleting it is the
 * only answer that means anything.
 */
export function isWritable(dir: string): true | string {
  const probe = join(dir, '.write-test-' + randomUUID())
  const body = 'simitboi'
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, body, 'utf8')
    // Read back rather than trusting the write: a filesystem that silently
    // discards or truncates is rarer than one that refuses, but it is the case
    // that produces a corrupt database instead of an error message.
    if (readFileSync(probe, 'utf8') !== body) return 'files written here do not read back'
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? (error as Error).message
  } finally {
    try { rmSync(probe, { force: true }) } catch { /* nothing left to clean up */ }
  }
}

/**
 * The machine-local per-user directory.
 *
 * LOCALAPPDATA, not APPDATA: APPDATA roams to a domain
 * profile, and a 116 MB simulator plus a gear database copying itself across a
 * corporate network on every login is the opposite of what anyone wants.
 * Electron's `appData` is the roaming one, so this reads the environment
 * directly and only falls back to Electron's answer off Windows.
 */
export function localAppDataDir(electronAppData: string): string {
  const local = process.platform === 'win32' ? process.env['LOCALAPPDATA'] : undefined
  return join(local && local.trim() !== '' ? local : electronAppData, 'SimItBoi')
}

export interface ResolveOptions {
  isPackaged: boolean
  /** Directory holding the executable, for the portable location. */
  exeDir: string
  /** Electron's `app.getPath('appData')`, used only off Windows. */
  electronAppData: string
  /** Overrides everything when set; dev and the UI checks use it. */
  devDir?: string
  cwd?: string
}

/**
 * Picks the data directory, preferring the portable one beside the executable.
 *
 * Throws only when neither location is usable, because at that point there is
 * nowhere to put a database and starting anyway would mean losing every report
 * the user saves.
 */
export function resolveDataDir(options: ResolveOptions): DataDirChoice {
  if (!options.isPackaged) {
    const dev = options.devDir ?? join(options.cwd ?? process.cwd(), 'data')
    mkdirSync(dev, { recursive: true })
    return { dir: dev, portable: false, fellBack: false, reason: null }
  }

  const portable = join(options.exeDir, 'data')
  const writable = isWritable(portable)
  if (writable === true) return { dir: portable, portable: true, fellBack: false, reason: null }

  const fallback = localAppDataDir(options.electronAppData)
  const fallbackWritable = isWritable(fallback)
  if (fallbackWritable === true) {
    return {
      dir: fallback,
      portable: true,
      fellBack: true,
      reason: portable + ' is not writable (' + writable + ')'
    }
  }
  throw new Error(
    'SimItBoi has nowhere to store its data. ' + portable + ' failed with ' + writable +
    ' and ' + fallback + ' failed with ' + fallbackWritable + '.'
  )
}
