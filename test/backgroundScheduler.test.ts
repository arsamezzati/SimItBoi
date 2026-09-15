import test from 'node:test'
import assert from 'node:assert/strict'
import { BackgroundScheduler } from '../src/core/data/backgroundScheduler.ts'

function abortable<T>(signal: AbortSignal, value: T, onStart?: () => void): Promise<T> {
  onStart?.()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), 20)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error)
    }, { once: true })
  })
}

test('identical background requests coalesce and cache', async () => {
  const scheduler = new BackgroundScheduler<number>()
  let calls = 0
  const work = (signal: AbortSignal): Promise<number> => abortable(signal, 7, () => calls++)
  assert.deepEqual(await Promise.all([scheduler.run('same', work), scheduler.run('same', work)]), [7, 7])
  assert.equal(await scheduler.run('same', work), 7)
  assert.equal(calls, 1)
})

test('a new key cancels obsolete work before starting', async () => {
  const scheduler = new BackgroundScheduler<string>()
  let active = 0
  let maximum = 0
  const work = (value: string) => async (signal: AbortSignal): Promise<string> => {
    active++; maximum = Math.max(maximum, active)
    try { return await abortable(signal, value) } finally { active-- }
  }
  const obsolete = scheduler.run('old', work('old'))
  const current = scheduler.run('new', work('new'))
  await assert.rejects(obsolete, /abort/i)
  assert.equal(await current, 'new')
  assert.equal(maximum, 1)
})

test('keyed cancellation cannot stop a newer request', async () => {
  const scheduler = new BackgroundScheduler<number>()
  const current = scheduler.run('new', (signal) => abortable(signal, 3))
  scheduler.cancelIf('old')
  assert.equal(await current, 3)

  const cancelled = scheduler.run('other', (signal) => abortable(signal, 4))
  scheduler.cancelIf('other')
  await assert.rejects(cancelled, /abort/i)
  await scheduler.cancelAndWait()
  assert.equal(scheduler.busy, false)
})

test('cancelAndWait retains ownership through asynchronous cleanup', async () => {
  const scheduler = new BackgroundScheduler<number>()
  let cleaned = false
  const pending = scheduler.run('slow', (signal) => new Promise<number>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      setTimeout(() => {
        cleaned = true
        const error = new Error('aborted'); error.name = 'AbortError'; reject(error)
      }, 10)
    }, { once: true })
  }))
  await scheduler.cancelAndWait()
  await assert.rejects(pending, /abort/i)
  assert.equal(cleaned, true)
  assert.equal(scheduler.busy, false)
})

test('cache size is bounded', async () => {
  const scheduler = new BackgroundScheduler<number>(1)
  let calls = 0
  const run = (key: string, value: number) => scheduler.run(key, async () => { calls++; return value })
  await run('a', 1); await run('b', 2); await run('a', 1)
  assert.equal(calls, 3)
})

// Every resolved result was cached, and a failure is a resolved result. A
// request that failed once was answered from the cache for as long as its key
// lived, so retrying it could not possibly do anything. The counter in each of
// these is the point: it distinguishes "ran again" from "looked successful".

test('a result the caller will not cache is recomputed', async () => {
  const scheduler = new BackgroundScheduler<{ ok: boolean }>(8, (r) => r.ok)
  let runs = 0
  const work = (ok: boolean) => async (): Promise<{ ok: boolean }> => { runs++; return { ok } }

  assert.deepEqual(await scheduler.run('k', work(false)), { ok: false })
  assert.equal(runs, 1)
  // The retry: same key, and it must actually execute rather than replay.
  assert.deepEqual(await scheduler.run('k', work(true)), { ok: true })
  assert.equal(runs, 2, 'a failed result was served from the cache')
  // Now that it succeeded, asking again is free.
  assert.deepEqual(await scheduler.run('k', work(false)), { ok: true })
  assert.equal(runs, 2, 'a successful result was recomputed')
})

test('caching everything is still the default', async () => {
  const scheduler = new BackgroundScheduler<number>(8)
  let runs = 0
  const work = async (): Promise<number> => { runs++; return runs }
  assert.equal(await scheduler.run('k', work), 1)
  assert.equal(await scheduler.run('k', work), 1)
  assert.equal(runs, 1)
})

test('invalidating one key leaves the others cached', async () => {
  const scheduler = new BackgroundScheduler<number>(8)
  let runs = 0
  const work = async (): Promise<number> => { runs++; return runs }
  await scheduler.run('a', work)
  await scheduler.run('b', work)
  assert.equal(runs, 2)

  assert.equal(scheduler.invalidate('a'), true)
  assert.equal(scheduler.invalidate('nothing-here'), false)
  await scheduler.run('a', work)
  assert.equal(runs, 3, 'an invalidated key was not recomputed')
  await scheduler.run('b', work)
  assert.equal(runs, 3, 'invalidating one key dropped another')

  scheduler.clearCache()
  await scheduler.run('b', work)
  assert.equal(runs, 4, 'clearCache left an entry behind')
})
