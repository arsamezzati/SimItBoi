/**
 * simc process runner.
 *
 * Everything here encodes something the M0 spike actually measured — the
 * progress format, the version banner shape, and the
 * report_details tradeoff.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface SimProgress {
  /** e.g. "Generating Baseline". */
  phase: string
  /** Position within the phase, e.g. 1 of 1. */
  phaseIndex: number
  phaseTotal: number
  completed: number
  total: number
  /**
   * The trailing number on simc's progress line. Measured to climb and then
   * plateau (~330-370 across different profiles and iteration counts), so it is
   * a throughput/rate metric, NOT dps — do not display it as dps. Its exact
   * unit is unverified.
   */
  throughput: number
  /** 0..1 */
  fraction: number
}

export interface RunOptions {
  /** Absolute path to simc.exe. */
  simcPath: string
  /** Full .simc input text. */
  input: string
  /**
   * Drop per-ability stats, buffs, procs and gains. 24x smaller output.
   * Keeps player.gear and profileset results, so it is correct for metadata
   * probes and Top Gear batches — but NOT for a detailed Quick Sim report.
   */
  leanReport?: boolean
  onProgress?: (p: SimProgress) => void
  onLine?: (line: string) => void
  signal?: AbortSignal
}

export interface RunResult {
  json: unknown
  stdout: string
  exitCode: number
  durationMs: number
  /** Parsed from this run's own banner — every real run emits it. */
  version: SimcVersion | null
}

export class SimcError extends Error {
  readonly exitCode: number
  readonly stdout: string

  constructor(message: string, exitCode: number, stdout: string) {
    super(message)
    this.name = 'SimcError'
    this.exitCode = exitCode
    this.stdout = stdout
  }
}

/**
 * simc emits progress on ONE line, carriage-return updated:
 *   Generating Baseline: 1/1 [=====>..............] 32/100 270.420
 */
const RE_PROGRESS =
  /^(.+?):\s*(\d+)\/(\d+)\s*\[[=>.\s]*\]\s*(\d+)\/(\d+)\s+([\d.]+)/

export function parseProgressLine(line: string): SimProgress | null {
  const m = line.trim().match(RE_PROGRESS)
  if (!m) return null
  const completed = Number(m[4])
  const total = Number(m[5])
  return {
    phase: m[1].trim(),
    phaseIndex: Number(m[2]),
    phaseTotal: Number(m[3]),
    completed,
    total,
    throughput: Number(m[6]),
    fraction: total > 0 ? completed / total : 0
  }
}

/**
 * simc's version banner. Note the bare-invocation form prefixes it with
 * "Nothing to sim!" on the SAME line.
 *   SimulationCraft 1210-01 for World of Warcraft 12.1.0.69587 Live (...)
 */
export interface SimcVersion {
  /** Patch-encoded build, e.g. "1210-01" meaning 12.1.0. */
  build: string
  wowBuild: string
  raw: string
}

export function parseVersionBanner(text: string): SimcVersion | null {
  const m = text.match(
    /SimulationCraft\s+(\d+-\d+)\s+for\s+World of Warcraft\s+([\d.]+)/i
  )
  if (!m) return null
  return { build: m[1], wowBuild: m[2], raw: m[0] }
}

/**
 * Compares patch-encoded simc builds ("1210-01" vs "1000-01").
 * Returns <0, 0 or >0. Used for the version gate against the addon's
 * `# Requires SimulationCraft <build> or newer` line.
 */
export function compareSimcBuild(a: string, b: string): number {
  const parse = (v: string): [number, number] => {
    const [maj, min] = v.split('-')
    return [Number(maj) || 0, Number(min) || 0]
  }
  const [am, an] = parse(a)
  const [bm, bn] = parse(b)
  return am !== bm ? am - bm : an - bn
}

/**
 * Reads simc's build version.
 *
 * There is NO version flag. `simc.exe` with no arguments writes nothing at all
 * when stdout is a pipe (it only prints the banner to a TTY), and `help` /
 * `--version` are treated as input filenames. The banner is emitted only during
 * a real run, so we run a minimal valid profile — ~0.15s.
 */
export async function probeVersion(simcPath: string, signal?: AbortSignal): Promise<SimcVersion | null> {
  signal?.throwIfAborted()
  const dir = await mkdtemp(join(tmpdir(), 'simitboi-ver-'))
  const probe = join(dir, 'probe.simc')
  try {
    const minimal = [
      'shaman="VersionProbe"',
      'level=90',
      'race=tauren',
      'spec=elemental',
      'role=spell',
      'iterations=1',
      'max_time=1',
      ''
    ].join('\n')
    await writeFile(probe, minimal, 'utf8')
    const res = await runRaw(simcPath, [probe], signal)
    signal?.throwIfAborted()
    return parseVersionBanner(res.stdout)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function runRaw(
  simcPath: string,
  args: string[],
  signal: AbortSignal | undefined,
  onChunk?: (chunk: string) => void
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    // argv array, never a concatenated string — paths contain spaces.
    const child: ChildProcess = spawn(simcPath, args, { windowsHide: true })
    let stdout = ''
    const onAbort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString()
      stdout += s
      onChunk?.(s)
    })
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString()
      stdout += s
      onChunk?.(s)
    })
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, exitCode: code ?? -1 })
    })
  })
}

/**
 * Runs a simulation and returns the parsed JSON report.
 * Input and output go through a temp directory that is always cleaned up.
 */
export async function runSim(opts: RunOptions): Promise<RunResult> {
  opts.signal?.throwIfAborted()
  const started = Date.now()
  const dir = await mkdtemp(join(tmpdir(), 'simitboi-'))
  const inputPath = join(dir, 'input.simc')
  const jsonPath = join(dir, 'out.json')

  try {
    await writeFile(inputPath, opts.input, 'utf8')

    const args = [inputPath, `json=${jsonPath}`]
    if (opts.leanReport) args.push('report_details=0')

    // simc rewrites the progress line with \r, so buffer and split on both.
    let carry = ''
    const res = await runRaw(opts.simcPath, args, opts.signal, (chunk) => {
      carry += chunk
      const parts = carry.split(/[\r\n]/)
      carry = parts.pop() ?? ''
      for (const part of parts) {
        if (part.trim() === '') continue
        opts.onLine?.(part)
        const prog = parseProgressLine(part)
        if (prog) opts.onProgress?.(prog)
      }
    })

    opts.signal?.throwIfAborted()
    if (res.exitCode !== 0) {
      throw new SimcError(`simc exited with code ${res.exitCode}`, res.exitCode, res.stdout)
    }

    let json: unknown
    try {
      json = JSON.parse(await readFile(jsonPath, 'utf8'))
    } catch {
      throw new SimcError('simc produced no readable JSON output', res.exitCode, res.stdout)
    }

    opts.signal?.throwIfAborted()
    return {
      json,
      stdout: res.stdout,
      exitCode: res.exitCode,
      durationMs: Date.now() - started,
      version: parseVersionBanner(res.stdout)
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
