import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { runTopGear, planShortlist, buildBatchInput, gearDifferences } from '../src/core/topgear/funnel.ts'
import { SingleJob } from '../src/core/simc/jobs.ts'
import { runSim, type RunOptions, type RunResult } from '../src/core/simc/runner.ts'

const raw = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
const version = { build: '1210-01', wowBuild: '12.1.0.69587', raw: 'test' }
function fakeEngine(fail?: string) {
  const calls: RunOptions[] = []
  let clock = 0, failed = false
  return { calls, deps: {
    hardware: { threads: 4, freeMemory: 64 * 1024 * 1024 }, now: () => clock,
    probe: async () => version,
    fingerprint: async () => 'a'.repeat(64),
    run: async (opts: RunOptions): Promise<RunResult> => {
      opts.signal?.throwIfAborted()
      calls.push(opts); clock += 100
      const names = [...opts.input.matchAll(/^profileset\."([gc]\d+)"=/gm)].map((m) => m[1])
      if (!failed && fail && names.includes(fail)) {
        failed = true
        throw Object.assign(new Error('Rejected item'), { stdout: `Error: Profileset '${fail}': Invalid item type` })
      }
      const dps = !opts.leanReport && opts.input.includes('off_hand=none') ? 110 : 100
      return { stdout: '', exitCode: 0, durationMs: 100, version, json: { sim: {
        players: [{ name: 'Test', collected_data: { dps: { mean: dps, mean_std_dev: 1, count: 1000 }, dmg: { mean: 30000 } },
          stats: opts.leanReport ? [] : [{ name: 'spell', type: 'damage', compound_amount: 30000 }] }],
        profilesets: { results: names.map((name, i) => ({ name, mean: 100 + i, mean_error: 1 })) }
      } } }
    }
  } }
}

test('calibration adapts shortlist size to measured time and memory', () => {
  const fast = planShortlist(60000, 10, 100, 10000)
  const slow = planShortlist(60000, 100, 100, 10000)
  assert.ok(fast.size > slow.size)
  assert.equal(planShortlist(60000, 10, 100, 2).size, 2)
  assert.equal(planShortlist(-1000, 10, 100, 10000).size, 1)
  assert.throws(() => planShortlist(60000, 0, 100, 10))
})

test('batch overrides map names explicitly and clear an inherited off-hand', () => {
  const input = buildBatchInput('shaman="T"', [{ id: 'c0', gear: { off_hand: null } }], 'target_error=0.5')
  assert.ok(input.includes('profileset."c0"=off_hand=none'))
  assert.throws(() => buildBatchInput('', [{ id: 'bad"name', gear: {} }], ''))
})

test('funnel uses grouped scores, a loose shortlist batch, and standalone detailed reports', async () => {
  const engine = fakeEngine()
  const p = parseAddonProfile(raw)
  const index = p.bagItems.findIndex((c) => c.slotClass === 'neck' && c.ilvl >= 300)
  const result = await runTopGear(raw, { selectedIds: [p.equipped.length + index], budgetSeconds: 15 }, { simcPath: 'fake' }, engine.deps)
  assert.equal(result.combinationCount, '2')
  assert.equal(result.stageOneSimulated, 2)
  assert.equal(result.ranking.length, 2)
  assert.equal(result.ranking[0].delta, 10)
  assert.equal(result.ranking[0].changes.length, 1)
  assert.ok(result.ranking[0].report.abilities.length)
  assert.equal(result.settings.threads, 2)
  assert.ok(engine.calls.some((c) => c.leanReport && c.input.includes('profileset."g')))
  assert.ok(engine.calls.some((c) => c.leanReport && c.input.includes('profileset."c')))
  const standalone = engine.calls.filter((c) => !c.leanReport)
  assert.equal(standalone.length, 2) // baseline and winner
  assert.ok(standalone.every((c) => !c.input.includes('profileset.')))
  assert.ok(standalone.every((c) => c.input.includes('target_error=0.1')))
  assert.equal(result.metadata.version, 3)
})

test('unchanged equipped gear reuses the baseline rather than reporting a random upgrade', async () => {
  const engine = fakeEngine()
  const result = await runTopGear(raw, { selectedIds: [], budgetSeconds: 15 }, { simcPath: 'fake' }, engine.deps)
  assert.equal(result.ranking[0].delta, 0)
  assert.equal(result.ranking[0].reusedBaseline, true)
  assert.equal(result.detailedSimulated, 0)
  assert.equal(engine.calls.filter((c) => !c.leanReport).length, 1)
})

test('a rejected group choice is dropped with its identity and never assigned another score', async () => {
  const p = parseAddonProfile(raw)
  const index = p.bagItems.findIndex((c) => c.slotClass === 'neck' && c.ilvl >= 300)
  assert.ok(index >= 0)
  const engine = fakeEngine('g1')
  const result = await runTopGear(raw, { selectedIds: [p.equipped.length + index], budgetSeconds: 15 }, { simcPath: 'fake' }, engine.deps)
  assert.ok(result.rejected.some((r) => r.reason.includes('Invalid item type')))
  assert.equal(result.combinationCount, '1')
  assert.ok(!result.ranking[0].overrides.includes(result.rejected[0].description))
})

test('version gating and invalid selection fail before any simulation batch', async () => {
  const engine = fakeEngine()
  await assert.rejects(runTopGear(raw, { selectedIds: [], budgetSeconds: 15 }, { simcPath: 'fake' }, {
    ...engine.deps, probe: async () => ({ ...version, build: '999-01' })
  }), /requires simc/)
  await assert.rejects(runTopGear(raw, { selectedIds: [-1], budgetSeconds: 15 }, { simcPath: 'fake' }, engine.deps), /selection/)
  assert.equal(engine.calls.length, 0)
})

test('a changed binary cannot produce a report attributed to the original build', async () => {
  const engine = fakeEngine()
  let hashes = 0
  await assert.rejects(runTopGear(raw, { selectedIds: [], budgetSeconds: 15 }, { simcPath: 'fake' }, {
    ...engine.deps, fingerprint: async () => String(hashes++)
  }), /binary changed/)
})

test('cancelling a job retains its lock until cleanup and prevents overlapping runs', async () => {
  const jobs = new SingleJob()
  let release!: () => void
  const pending = jobs.run(async (signal) => {
    await new Promise<void>((resolve) => { release = resolve })
    signal.throwIfAborted()
  })
  jobs.cancel()
  assert.equal(jobs.busy, true)
  await assert.rejects(jobs.run(async () => 1), /already running/)
  release()
  await assert.rejects(pending, /abort/i)
  assert.equal(await jobs.run(async () => 2), 2)
})

test('pre-aborted runs never launch simc', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(runSim({ simcPath: 'nonexistent', input: '', signal: controller.signal }), /abort/i)
  const engine = fakeEngine()
  await assert.rejects(runTopGear(raw, { selectedIds: [], budgetSeconds: 15 }, { simcPath: 'fake', signal: controller.signal }, engine.deps), /abort/i)
  assert.equal(engine.calls.length, 0)
})

test('comparison avoids false ring-position changes', () => {
  const p = parseAddonProfile('shaman="T"\nfinger1=,id=1\nfinger2=,id=2\n')
  assert.deepEqual(gearDifferences(p, { finger1: p.equipped[1], finger2: p.equipped[0] }), [])
})
