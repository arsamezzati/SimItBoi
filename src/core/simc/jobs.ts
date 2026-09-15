/** Keeps cancellation ownership until the child process has actually stopped. */
export class SingleJob {
  private controller: AbortController | null = null
  get busy(): boolean { return this.controller !== null }
  cancel(): void { this.controller?.abort() }
  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.controller) throw new Error('A simulation is already running. Cancel it or wait for it to finish.')
    const controller = new AbortController()
    this.controller = controller
    try { return await work(controller.signal) }
    finally { if (this.controller === controller) this.controller = null }
  }
}
