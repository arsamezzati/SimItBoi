export const RUN_ENVELOPE_VERSION = 1 as const

export interface RunEnvelope<T = unknown> {
  envelopeVersion: typeof RUN_ENVELOPE_VERSION
  kind: 'quick' | 'loadouts' | 'topgear'
  appVersion: string
  input: string
  settings: Readonly<Record<string, unknown>>
  simulator: Readonly<{ build: string; wowBuild?: string; sha256: string }>
  /** Content identity per shipped data file, keyed by file name. */
  data: Readonly<Record<string, string>>
  warnings: readonly string[]
  result: T
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  }
  return value
}

/** Creates a detached, immutable snapshot suitable for report persistence. */
export function createRunEnvelope<T>(input: Omit<RunEnvelope<T>, 'envelopeVersion'>): RunEnvelope<T> {
  return freeze(structuredClone({ envelopeVersion: RUN_ENVELOPE_VERSION, ...input }))
}

export function isRunEnvelope(value: unknown): value is RunEnvelope {
  return !!value && typeof value === 'object' &&
    (value as { envelopeVersion?: unknown }).envelopeVersion === RUN_ENVELOPE_VERSION &&
    typeof (value as { input?: unknown }).input === 'string' && 'result' in value
}

/** Legacy report payloads were the result object itself. */
export function unwrapRunPayload<T>(value: unknown): T {
  return (isRunEnvelope(value) ? value.result : value) as T
}

export function storedRunInput(value: unknown): string | undefined {
  if (isRunEnvelope(value)) return value.input
  const input = (value as { input?: unknown } | null)?.input
  return typeof input === 'string' ? input : undefined
}
