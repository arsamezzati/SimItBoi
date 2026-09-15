import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron, expect } from '@playwright/test'
import { buildsRoot, stageBuild } from '../src/core/simc/provision.ts'

const require = createRequire(import.meta.url)
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined)) as Record<string, string>
env.SIMITBOI_DEV_DATA_DIR = resolve('data/ui-test')
delete env.ELECTRON_RENDERER_URL
mkdirSync('data', { recursive: true })
const app = await electron.launch({ executablePath: require('electron') as string, args: ['out/main/index.js'], env })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('console', (message) => { if (message.type() === 'error') console.log('Renderer:', message.text()) })
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  await page.waitForLoadState('domcontentloaded')
  await page.context().setOffline(true)
  await app.evaluate(({ BrowserWindow }) => { for (const win of BrowserWindow.getAllWindows()) win.hide() })
  await expect(page.locator('.meta')).not.toContainText('checking', { timeout: 15000 })
  // The app provisions a simc build before the first window and runs from
  // that copy, not from wherever the binary happened to be lying. Everything
  // below this line is therefore already simulating with a provisioned build.
  const provisioned = await page.evaluate(async () => {
    const api = (window as any).simitboi
    return { env: await api.envInfo(), builds: await api.simcBuilds() }
  })
  assert.ok(provisioned.env.simcBuildId, 'no simc build was provisioned: ' + provisioned.env.simcProblem)
  assert.equal(provisioned.env.simcSource, 'bundled')
  assert.ok(String(provisioned.env.simcPath).includes(provisioned.env.simcBuildId),
    'the app is not running the build it provisioned: ' + provisioned.env.simcPath)
  assert.equal(provisioned.builds.ok, true)
  const active = provisioned.builds.builds.find((b: { active: boolean }) => b.active)
  assert.ok(active, 'no build is marked active')
  assert.deepEqual(active.problems, [], 'the active build does not verify')
  // Nothing to roll back to yet, and that is reported rather than thrown.
  const noRollback = await page.evaluate(() => (window as any).simitboi.rollbackSimcBuild())
  assert.equal(noRollback.ok, false)
  assert.match(noRollback.error, /no previous simc build/)
  await page.getByLabel('Paste your SimC addon string').fill(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  await page.getByRole('button', { name: 'Top Gear', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose your gear' })).toBeVisible()
  await page.screenshot({ path: 'data/m7-selection.png', fullPage: true })
  // Exact hover identity: same item id at 334/308 must render separate stats.
  const chestVariants = page.locator('.candidate').filter({ hasText: 'Fanged Raiment' })
  await expect(chestVariants).toHaveCount(2)
  // Stats arrive from a background probe, so read both repeatedly rather than
  // once: a single read can catch the second variant still showing the first
  // one's numbers, which fails intermittently and teaches everyone to re-run
  // the check instead of believing it.
  const variantStats = async (index: number): Promise<string> => {
    await chestVariants.nth(index).locator('.item-cell').focus()
    await expect(page.getByRole('tooltip')).toHaveCount(1)
    await expect(page.getByRole('tooltip').locator('.tip-stats')).toBeVisible({ timeout: 15000 })
    return await page.getByRole('tooltip').locator('.tip-stats').innerText()
  }
  let firstChestStats = ''
  let secondChestStats = ''
  await expect.poll(async () => {
    firstChestStats = await variantStats(0)
    secondChestStats = await variantStats(1)
    return firstChestStats === secondChestStats
  }, { timeout: 30000, message: '334/308 hover variants displayed the same stats' }).toBe(false)
  assert.notEqual(firstChestStats, secondChestStats, '334/308 hover variants displayed the same stats')
  await chestVariants.nth(1).locator('strong').hover()
  await expect(page.getByRole('tooltip')).toHaveCount(1)
  const tipBounds = await page.getByRole('tooltip').boundingBox()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert(tipBounds && tipBounds.x >= 0 && tipBounds.y >= 0 && tipBounds.x + tipBounds.width <= viewport.width && tipBounds.y + tipBounds.height <= viewport.height, 'Tooltip must fit viewport')
  await expect(page.getByRole('tooltip')).toContainText('Ophidian Oracle')
  await expect(page.getByRole('tooltip')).toContainText('(2) Set:')
  await expect(page.getByRole('tooltip')).toContainText('(4) Set:')
  await page.screenshot({ path: 'data/ui-item-tooltip.png' })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.getByRole('button', { name: 'Equipped only', exact: true }).click()
  await page.locator('.gear-filters').getByRole('button', { name: 'Add new gear', exact: true }).click()
  await page.getByLabel('Search items', { exact: true }).fill('Lightspire Core')
  await page.getByRole('button', { name: /Lightspire Core.*250214/ }).hover()
  await expect(page.getByRole('tooltip')).toContainText('Lightspire Core')
  await page.getByRole('button', { name: /Lightspire Core.*250214/ }).click()
  await page.getByLabel('Upgrade track').selectOption('Hero')
  await page.getByLabel('Item level', { exact: true }).selectOption('321')
  await page.getByRole('button', { name: 'Add item to gear', exact: true }).click()
  await expect(page.locator('.hypothetical-list')).toContainText('Hero 6/6')
  await page.getByLabel('Upgrade track').selectOption('Myth')
  await page.getByLabel('Item level', { exact: true }).selectOption('334')
  await page.getByRole('button', { name: 'Add item to gear', exact: true }).click()
  await expect(page.locator('.hypothetical-list li')).toHaveCount(2)
  await expect(page.locator('.hypothetical-list')).toContainText('334 ilvl')
  // Edit one variant without creating another owned copy.
  await page.locator('.hypothetical-list li').first().getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Item level', { exact: true }).selectOption('318')
  await page.getByRole('button', { name: 'Save item changes' }).click()
  await expect(page.locator('.hypothetical-list li')).toHaveCount(2)
  await expect(page.locator('.hypothetical-list')).toContainText('Hero 5/6')
  await page.locator('.hypothetical-list li').first().getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Item level', { exact: true }).selectOption('321')
  await page.getByRole('button', { name: 'Save item changes' }).click()
  await page.getByRole('button', { name: 'Add item to gear', exact: true }).click()
  await expect(page.locator('.hypothetical-list li')).toHaveCount(3)
  await page.locator('.hypothetical-list li').last().getByRole('button', { name: 'Remove' }).click()
  await expect(page.locator('.hypothetical-list li')).toHaveCount(2)
  // Guided gems and slot-compatible enchants.
  await page.getByLabel('Search items', { exact: true }).fill('Alluring Bubbleband')
  await page.getByRole('button', { name: /Alluring Bubbleband.*268266/ }).click()
  await expect(page.getByText('1/1 sockets')).toHaveCount(0) // nothing gemmed yet
  await page.getByRole('button', { name: 'Add gem', exact: true }).click()
  await expect(page.getByLabel('Gem 1', { exact: true })).toBeVisible()
  // A gem with more than one crafting quality exposes a quality choice.
  await page.getByLabel('Gem 1', { exact: true }).selectOption('Deadly Amethyst')
  await expect(page.getByLabel('Gem 1 quality', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Gem 1 quality', { exact: true }).locator('option')).toHaveCount(2)
  await page.getByLabel('Gem 1 quality', { exact: true }).selectOption({ label: 'Quality 2' })
  // Icons, not the ◇ fallback.
  await expect(page.locator('.gear-addon-row img.item-icon').first()).toBeVisible()
  await page.getByRole('button', { name: 'Add enchant', exact: true }).click()
  await expect(page.getByLabel('Enchant', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Enchant quality', { exact: true })).toBeVisible()
  await expect(page.getByText(/Crafted items and embellishments require an exact SimC item string/)).toBeVisible()
  await page.locator('.variant-config').screenshot({ path: 'data/gear-controls.png' })
  await page.getByRole('button', { name: 'Add item to gear', exact: true }).click()
  await expect(page.locator('.hypothetical-list li')).toHaveCount(3)
  // The validated addon tokens reached the string.
  await expect(page.locator('.hypothetical-list')).toContainText('gem_id=')
  await expect(page.locator('.hypothetical-list')).toContainText('enchant_id=')
  // Editing restores configured addon fields, not just track and level.
  await page.locator('.hypothetical-list li').last().getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByLabel('Gem 1', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Enchant', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save item changes' }).click()
  await expect(page.locator('.hypothetical-list li')).toHaveCount(3)
  await page.locator('.hypothetical-list li').last().getByRole('button', { name: 'Remove' }).click()
  await expect(page.locator('.hypothetical-list li')).toHaveCount(2)
  // Crafted items: recipe-backed configuration, eligibility and restore.
  await page.getByRole('button', { name: 'Crafted', exact: true }).click()
  // Two words, reversed, both containing an s: the single word 'Farstrider'
  // used here before happened to survive a tokenizer that split on the letter
  // s, so this check passed while the search was broken for real queries.
  await page.getByLabel('Search crafted items', { exact: true }).fill('reinforced farstrider')
  await page.getByRole('button', { name: /Farstrider's Reinforced Faulds.*244582/ }).click()
  await expect(page.getByLabel('Dawncrest infusion', { exact: true })).toBeVisible()
  // Exactly two stats are required before the item can be added.
  const addCrafted = page.getByRole('button', { name: 'Add crafted item', exact: true })
  await expect(addCrafted).toBeDisabled()
  await page.getByLabel('Versatility', { exact: true }).check()
  await page.getByLabel('Critical Strike', { exact: true }).check()
  await expect(addCrafted).toBeEnabled()
  // Only embellishments legal for this slot are offered.
  await page.getByRole('button', { name: 'Add embellishment', exact: true }).click()
  const embellishOptions = await page.getByLabel('Embellishment', { exact: true }).locator('option').allTextContents()
  assert.ok(embellishOptions.length > 0, 'no embellishment offered for crafted legs')
  assert.ok(!embellishOptions.includes('Coiled Snake-Eye'), 'a gun embellishment was offered on legs')
  // Slot alone is not eligibility. Nothing from another expansion may be
  // offered, and the main process must refuse it even if the list were wrong.
  assert.ok(!embellishOptions.includes('Toxified'), 'a Dragon Isles embellishment was offered on a Midnight recipe')
  const offered = await page.evaluate(async (fixture) => {
    const api = (window as any).simitboi
    const listed = await api.gearOptions()
    const foreign = listed.ok ? listed.embellishments.filter((e: { expansion: string }) => e.expansion !== 'Midnight') : []
    // Toxified Armor Patch is leather-and-mail, so it clears the armor-class
    // rule on this mail recipe and the character can equip it. Only its
    // expansion makes it illegal, which is precisely what slot alone missed.
    const crossExpansion = await api.configureCrafted(fixture, {
      kind: 'crafted', itemId: 244582, ladderBonusId: 12497, craftingQuality: 5,
      craftedStats: [40, 32], embellishmentBonusId: 8797
    })
    // A plate chest with that same patch, refused for any reason at all.
    const plateChest = await api.configureCrafted(fixture, {
      kind: 'crafted', itemId: 237829, ladderBonusId: 12493, craftingQuality: 5,
      craftedStats: [32, 36], embellishmentBonusId: 8797
    })
    return { foreignCount: foreign.length, crossExpansion, plateChest }
  }, readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  assert.ok(offered.foreignCount > 0, 'no other-expansion embellishment exists to be refused')
  assert.equal(offered.crossExpansion.ok, false, 'a Dragon Isles patch was accepted on a Midnight recipe')
  assert.match(offered.crossExpansion.error, /Dragon Isles/)
  assert.equal(offered.plateChest.ok, false)
  assert.ok(!embellishOptions.includes('Polished Ammolite'), 'an accessory embellishment was offered on legs')
  await page.locator('.variant-config').screenshot({ path: 'data/crafted-picker.png' })
  await addCrafted.click()
  await expect(page.locator('.hypothetical-list li')).toHaveCount(3)
  await expect(page.locator('.hypothetical-list')).toContainText('crafted_stats=40/32')
  await expect(page.locator('.hypothetical-list')).toContainText('crafting_quality=5')
  await expect(page.locator('.hypothetical-list')).toContainText('331 ilvl · crafted')
  // Editing a crafted entry opens the crafted picker with every choice restored.
  await page.locator('.hypothetical-list li').last().getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByLabel('Dawncrest infusion', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Embellishment', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Versatility', { exact: true })).toBeChecked()
  await page.getByLabel('Dawncrest infusion', { exact: true }).selectOption({ index: 0 })
  await page.getByRole('button', { name: 'Save craft changes', exact: true }).click()
  await expect(page.locator('.hypothetical-list li')).toHaveCount(3)
  await expect(page.locator('.hypothetical-list')).toContainText('318 ilvl · crafted')
  await page.locator('.hypothetical-list li').last().getByRole('button', { name: 'Remove' }).click()
  await expect(page.locator('.hypothetical-list li')).toHaveCount(2)
  await page.getByRole('button', { name: 'Drops', exact: true }).click()

  await page.getByLabel('Search items', { exact: true }).fill('thisdoesnotexistzzzz')
  await expect(page.locator('.search-results')).toContainText('No items match')
  await page.getByLabel('Search items', { exact: true }).fill('Lightspire Core')
  await page.getByRole('button', { name: /Lightspire Core.*250214/ }).hover()
  await expect(page.getByRole('tooltip')).toContainText('Lightspire Core')
  await page.getByRole('button', { name: /Lightspire Core.*250214/ }).click()
  await expect.poll(() => page.locator('.search-results img').first().evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await page.setViewportSize({ width: 640, height: 900 })
  await page.screenshot({ path: 'data/m8-narrow.png', fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.setViewportSize({ width: 1169, height: 900 })
  await page.screenshot({ path: 'data/m8-picker.png', fullPage: true })
  const invalid = await page.evaluate(async (raw) => {
    const api = (window as any).simitboi
    return api.configureItem(raw, { itemId: 250214, track: 'Hero', ilvl: 999 })
  }, readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  assert.equal(invalid.ok, false)
  const guarded = await page.evaluate(async (raw) => {
    const api = (window as any).simitboi
    const base = { itemId: 250214, track: 'Hero', ilvl: 321 }
    return Promise.all([
      api.configureItem(raw, { ...base, craftingQuality: 5 }),
      api.configureItem(raw, { ...base, embellishmentBonusId: 13767 }),
      api.configureItem(raw, { ...base, enchantId: 7964 })
    ])
  }, readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  assert.deepEqual(guarded.map((r: { ok: boolean }) => r.ok), [false, false, false])
  await page.locator('summary').filter({ hasText: 'Advanced: import an exact SimC item' }).click()
  await expect(page.locator('.hypothetical-add select option')).toHaveText(['Unknown', 'Yes', 'No'])
  // A typed item string skipped the within-item gem check that both guided
  // pickers apply, and the solver then counted two copies of a quantity-1 gem
  // as one unit. It must be refused, with the reason shown, and the two legal
  // items must still be used.
  await page.getByLabel('Item string', { exact: true }).fill('neck=,id=268251,gem_id=240966/240966')
  await page.getByRole('button', { name: 'Add item', exact: true }).click()
  await expect(page.locator('.hypothetical-list li')).toHaveCount(3)
  await page.locator('.run-bar').getByLabel('Search time').selectOption('60')
  // Fight length and search time are separate settings that both used to read
  // as minutes. Each must have exactly one control and keep its own value.
  await page.locator('.run-bar').getByLabel('Fight length').selectOption('180')
  await expect(page.locator('.run-bar').getByLabel('Search time')).toHaveValue('60')
  await expect(page.locator('.run-bar').getByLabel('Fight length')).toHaveValue('180')
  await page.locator('.run-bar').getByLabel('Fight length').selectOption('300')
  await page.getByRole('button', { name: 'Find top gear', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Top Gear comparison', exact: true })).toBeVisible({ timeout: 120000 })
  await expect(page.locator('.comparison tbody tr')).not.toHaveCount(1)
  // The two guided items in the list must actually reach the simulation. They
  // resolved when added and were then rejected at run time once, because the
  // identity stamped on a configured selection was not the one resolution
  // compared, so Top Gear silently simulated without them.
  const hypotheticalSummary = page.locator('.run-details summary').filter({ hasText: 'New gear' })
  await expect(hypotheticalSummary).toHaveText('New gear (2 used, 1 rejected)')
  await page.getByRole('heading', { name: 'Top Gear comparison', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'data/m7-comparison.png', fullPage: true })
  await page.locator('.comparison tbody tr').first().getByRole('button', { name: 'View' }).click()
  await expect(page.getByRole('heading', { name: 'Equipped gear report' })).toBeVisible()
  await page.reload()
  await page.getByLabel('Paste your SimC addon string').fill(readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await page.getByRole('button', { name: 'Restore selection', exact: true }).first().click()
  // All three come back, the refused one included: a rejected item is the
  // user's input and must not be silently dropped from their configuration.
  await expect(page.locator('.hypothetical-list li')).toHaveCount(3)
  await expect(page.locator('.hypothetical-list')).toContainText('Hero 6/6')
  await expect(page.locator('.hypothetical-list')).toContainText('Myth 6/6')
  await expect(page.locator('.hypothetical-list')).toContainText('gem_id=240966/240966')
  // Cancellation must release the job before allowing another Quick Sim.
  await page.getByRole('button', { name: 'Find top gear', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('cancelled', { timeout: 15000 })
  await expect(page.getByRole('heading', { name: 'Top Gear comparison', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Quick Sim', exact: true }).click()
  await page.getByRole('button', { name: 'Run quick sim', exact: true }).click()
  await expect(page.getByRole('heading', { name: /Damage breakdown/ })).toBeVisible({ timeout: 30000 })
  // A finished Quick Sim report must survive a cancelled rerun. It used to
  // be cleared the moment a run started, so cancelling left an empty pane.
  await expect(page.getByRole('heading', { name: /Damage breakdown/ })).toBeVisible()
  await page.getByRole('button', { name: 'Run quick sim', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('heading', { name: /Damage breakdown/ })).toBeVisible()

  // Every retained report must be reachable. Seed past one page, then page
  // through and assert the count actually grows.
  const seeded = await page.evaluate(async (fixture) => {
    const api = (window as any).simitboi
    const count = async (): Promise<number> => {
      const listed = await api.listHistory({ limit: 1 })
      return listed.ok ? listed.total : 0
    }
    // The data directory persists between runs, so only top up what is missing.
    for (let guard = 0; guard < 60 && (await count()) <= 52; guard++) {
      await api.runSim(fixture, { iterations: 1 })
    }
    return count()
  }, readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  assert.ok(seeded > 50, `expected more than one page of history, got ${seeded}`)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(page.locator('.history tbody tr')).toHaveCount(50)
  const older = page.getByRole('button', { name: /Show [0-9]+ older/ })
  await expect(older).toBeVisible()
  await older.click()
  await expect.poll(() => page.locator('.history tbody tr').count()).toBeGreaterThan(50)
  // The count line must describe what is actually on screen, not the page size.
  const shown = await page.locator('.history tbody tr').count()
  await expect(page.locator('.history h3')).toContainText(`showing ${shown} of ${seeded}`)

  // Probe lifecycle: a newer profile cancels the old probe, and foreground work
  // can start during a cache-miss probe without seeing the shared-lock error.
  const schedulerLifecycle = await page.evaluate(async (fixture) => {
    const api = (window as any).simitboi
    const oldProbe = api.itemStats(`${fixture}\n# scheduler-old`)
    const newProbe = api.itemStats(`${fixture}\n# scheduler-new`)
    const [oldResult, newResult] = await Promise.all([oldProbe, newProbe])
    const yieldingProbe = api.itemStats(`${fixture}\n# scheduler-yield`)
    const foreground = api.runSim(fixture, { iterations: 1 })
    const [yielded, simulation] = await Promise.all([yieldingProbe, foreground])
    return { oldResult, newResult, yielded, simulation }
  }, readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  assert.equal(schedulerLifecycle.oldResult.ok, true)
  assert.equal(schedulerLifecycle.newResult.ok, true)
  assert.ok(Object.keys(schedulerLifecycle.newResult.stats).length > 0)
  assert.equal(schedulerLifecycle.yielded.ok, true)
  assert.equal(schedulerLifecycle.simulation.ok, true)
  // Provenance: an incompatible Loadout request stops at the shared gate,
  // and a checksum-free Quick report retains its exact input across restart.
  const provenance = await page.evaluate(async (fixture) => {
    const api = (window as any).simitboi
    const incompatible = fixture.replace('Requires SimulationCraft 1000-01', 'Requires SimulationCraft 9999-99')
    const gated = await api.runLoadouts(incompatible, { threads: 1, fightSeconds: 30 })
    const raw = fixture.replace(/^# Checksum:.*\r?\n/m, '')
    const quick = await api.runSim(raw, { iterations: 1 })
    if (!quick.ok) return { gated, quick }
    const stored = await api.getHistory(quick.reportId)
    return { gated, quick, stored, raw }
  }, readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  assert.equal(provenance.gated.ok, false)
  assert.match(provenance.gated.error, /requires simc/i)
  assert.equal(provenance.quick.ok, true)
  assert.equal(provenance.stored.ok, true)
  assert.equal(provenance.stored.row.profileChecksum, null)
  assert.equal(provenance.stored.payload.input, provenance.raw)
  assert.equal(provenance.stored.payload.result.dps.mean > 0, true)
  assert.match(provenance.stored.payload.simulator.sha256, /^[a-f0-9]{64}$/)
  const persistedId = provenance.quick.reportId
  await page.reload()
  const afterRestart = await page.evaluate((id) => (window as any).simitboi.getHistory(id), persistedId)
  assert.equal(afterRestart.ok, true)
  assert.equal(afterRestart.payload.input, provenance.raw)
  // A probe failure stays visible on every owned card without a retry/filter bar.
  await page.reload()
  const oversized = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
    + String.fromCharCode(10) + '# pad'.repeat(220000)
  await page.getByLabel('Paste your SimC addon string').fill(oversized)
  await page.getByRole('button', { name: 'Top Gear', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose your gear' })).toBeVisible()
  const failedCard = page.locator('.candidate').filter({ hasText: 'Fanged Raiment' }).first()
  await expect(failedCard.locator('.candidate-stats')).toContainText('too large to probe', { timeout: 30000 })
  await expect(page.getByRole('button', { name: /Retry stats/ })).toHaveCount(0)
  await page.reload()
  // Simulator builds panel: the version in the header opens it, and switching
  // builds actually changes what the app runs. A throwaway second build is
  // staged beside the real one so there is something to switch to; it is never
  // simulated with, and the real build is restored before anything else runs.
  const simcToggle = page.locator('.meta').getByRole('button', { name: /^simc / })
  await simcToggle.click()
  const panel = page.getByRole('region', { name: 'Simulator builds' })
  await expect(panel).toBeVisible()
  await expect(panel.locator('li.active')).toHaveCount(1)
  await expect(panel.locator('li.active')).toContainText('in use')
  const realBuild = (await panel.locator('li.active strong').innerText()).trim()

  const fakeSource = await mkdtemp(join(tmpdir(), 'simitboi-fake-simc-'))
  await writeFile(join(fakeSource, 'simc.exe'), 'not a simulator; exists only to be switched to' + String.fromCharCode(10))
  const fake = await stageBuild(buildsRoot(resolve('data/ui-test')), {
    dir: fakeSource, exe: 'simc.exe', version: '0000-01', source: 'ui-check', include: ['simc.exe']
  })
  await rm(fakeSource, { recursive: true, force: true })
  try {
    // Reopen so the panel re-reads the builds on disk.
    await simcToggle.click()
    await simcToggle.click()
    const fakeRow = panel.locator('li').filter({ hasText: fake.manifest.buildId })
    await expect(fakeRow).toContainText('from ui-check')
    await fakeRow.getByRole('button', { name: 'Use this build' }).click()
    await expect(panel.getByRole('status')).toContainText('Now using ' + fake.manifest.buildId)
    await expect(panel.locator('li.active strong')).toHaveText(fake.manifest.buildId)
    await expect(panel.locator('li').filter({ hasText: realBuild })).toContainText('previous')
    const switched = await page.evaluate(() => (window as any).simitboi.envInfo())
    assert.ok(String(switched.simcPath).includes(fake.manifest.buildId), 'switching did not change the binary the app runs')

    await panel.getByRole('button', { name: 'Roll back to previous build' }).click()
    await expect(panel.getByRole('status')).toContainText('Rolled back to ' + realBuild)
    await expect(panel.locator('li.active strong')).toHaveText(realBuild)
  } finally {
    // Whatever happened above, leave the real build active and the fake gone,
    // so later checks and the next run are unaffected.
    await page.evaluate((id) => (window as any).simitboi.activateSimcBuild(id), realBuild)
    await rm(join(buildsRoot(resolve('data/ui-test')), fake.manifest.buildId), { recursive: true, force: true })
  }
  const restored = await page.evaluate(() => (window as any).simitboi.envInfo())
  assert.ok(String(restored.simcPath).includes(realBuild), 'the real simc build was not restored')
  await expect(page.locator('.meta')).not.toContainText('not found')
  await simcToggle.click()
  await expect(panel).toHaveCount(0)

  // The shipped data validates, and a healthy app shows no recovery banner.
  // The gutted-snapshot case is a unit test; this proves the gate is not
  // permanently displaying a message a user cannot clear.
  const snapshot = await page.evaluate(() => (window as any).simitboi.envInfo())
  assert.deepEqual(snapshot.dataProblems, [], 'the shipped data snapshot does not validate')
  await expect(page.locator('.data-problems')).toHaveCount(0)

  assert.deepEqual(errors, [])
  // Leave a cache-miss probe active; app.close() must cancel and reap it.
  await page.evaluate((fixture) => { void (window as any).simitboi.itemStats(`${fixture}\n# scheduler-shutdown`) }, readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8'))
  console.log('Electron UI: exact hover stats, offline item flows, probe lifecycle, immutable report provenance/restart, version gates, crafted configuration with slot-legal embellishments and edit restore, Top Gear, paged History, result retention across cancellation, and Quick Sim passed.')
} finally { await app.close() }
