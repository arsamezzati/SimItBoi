/** One-owner scheduler for optional background work such as item stat probes. */
export class BackgroundScheduler<T> {
  private active: { key: string; controller: AbortController; promise: Promise<T> } | null = null
  private generation = 0
  private readonly cache = new Map<string, T>()
  private readonly maxCacheEntries: number
  private readonly cacheable: (result: T) => boolean

  /**
   * `cacheable` decides what is worth keeping. Everything resolved used to be
   * cached, and a failure is a resolved value — so a request that had failed
   * was answered from the cache for as long as its key lived, and retrying it
   * could never do anything. Failures are retryable; successes are not
   * worth recomputing. Only the caller can tell the two apart.
   */
  constructor(maxCacheEntries = 8, cacheable: (result: T) => boolean = () => true) {
    if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 0) throw new Error('Invalid background cache size')
    this.maxCacheEntries = maxCacheEntries
    this.cacheable = cacheable
  }

  /** Forgets one cached answer, so the next request recomputes it. */
  invalidate(key: string): boolean {
    return this.cache.delete(key)
  }

  /** Forgets every cached answer. */
  clearCache(): void {
    this.cache.clear()
  }

  get busy(): boolean { return this.active !== null }
  get activeKey(): string | undefined { return this.active?.key }

  private aborted(): Error {
    const error = new Error('Background request cancelled')
    error.name = 'AbortError'
    return error
  }

  /** Coalesce identical work, cancel obsolete work, and never run two jobs. */
  async run(key: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    if (this.active?.key === key) return this.active.promise

    const ticket = ++this.generation
    const previous = this.active
    if (previous) {
      previous.controller.abort()
      try { await previous.promise } catch { /* obsolete result */ }
    }
    if (ticket !== this.generation) throw this.aborted()

    const controller = new AbortController()
    let promise!: Promise<T>
    promise = work(controller.signal).then((result) => {
      controller.signal.throwIfAborted()
      if (this.maxCacheEntries > 0 && this.cacheable(result)) {
        this.cache.set(key, result)
        while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value!)
      }
      return result
    }).finally(() => {
      if (this.active?.promise === promise) this.active = null
    })
    this.active = { key, controller, promise }
    return promise
  }

  /** Cancel only the renderer request that owns the active key. */
  cancelIf(key: string): void {
    if (this.active?.key !== key) return
    this.generation++
    this.active.controller.abort()
  }

  cancel(): void {
    this.generation++
    this.active?.controller.abort()
  }

  /** Abort and wait until the child-owning work has actually cleaned up. */
  async cancelAndWait(): Promise<void> {
    this.cancel()
    const pending = this.active?.promise
    if (pending) try { await pending } catch { /* cancellation is expected */ }
  }
}
