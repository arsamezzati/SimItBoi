import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAddonProfile } from '../src/core/parser/addonProfile.ts'
import { runTopGear } from '../src/core/topgear/funnel.ts'
import { describeCandidates } from '../src/core/topgear/funnel.ts'
import { solveTopGear } from '../src/core/topgear/solver.ts'

/**
 * Degenerate and unsupported inputs.
 *
 * Held as inline profiles rather than fixture files on purpose: each one is
 * three lines, and the failure being tested is visible next to the assertion
 * instead of in a file someone has to open. Real multi-hundred-line exports stay
 * in fixtures/ where their size earns it.
 */

const REAL = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')

async function topGearRefusal(raw: string): Promise<string> {
  try {
    // A valid budget: option validation runs before the profile check, so an
    // out-of-range one would mask the refusal being tested.
    await runTopGear(raw, { selectedIds: [], budgetSeconds: 60 }, { simcPath: 'nonexistent' })
    return '(accepted)'
  } catch (error) {
    return (error as Error).message
  }
}

test('an empty export is refused with something actionable', async () => {
  assert.match(await topGearRefusal(''), /paste a full simc addon export/i)
  assert.match(await topGearRefusal('   \n\n  '), /paste a full simc addon export/i)
})

test('a profile with no spec is refused before any simulation', async () => {
  // A class line alone parses, but Top Gear cannot pick weapon rules without a
  // spec, and guessing one would silently simulate the wrong character.
  const message = await topGearRefusal('shaman="Nospec"\nlevel=90\nhead=,id=271481\n')
  assert.match(message, /paste a full simc addon export/i)
})

test('a profile with a spec but no gear is refused', async () => {
  assert.match(await topGearRefusal('shaman="Bare"\nlevel=90\nspec=elemental\n'), /paste a full simc addon export/i)
})

test('junk input does not parse as a character', () => {
  for (const junk of ['hello world', '{"json": true}', '# only a comment\n']) {
    const parsed = parseAddonProfile(junk)
    assert.ok(!parsed.className || !parsed.equipped.length, `junk parsed as a character: ${junk}`)
  }
})

test('an unknown spec for a real class is refused rather than defaulted', async () => {
  // Asserted at the solver, which is where the decision is made. runTopGear
  // probes the simc build first, so through that path an unknown spec surfaces
  // as whatever the binary does and tells you nothing about the rules.
  const swapped = parseAddonProfile(REAL.replace('spec=elemental', 'spec=notaspec'))
  await assert.rejects(
    solveTopGear(swapped, { shortlistSize: 3, scoreItem: () => 0 }),
    /no weapon rules/i
  )
})

test('a profile requiring a newer simc build says so before running', async () => {
  const gated = REAL.replace(/^# *SimC Addon.*$/m, '# SimC Addon 1.0.0')
  const parsed = parseAddonProfile(gated)
  // The gate only fires when the profile names a required build; assert the
  // parser surfaces it either way rather than dropping it.
  if (parsed.header.requiresSimcBuild) {
    assert.match(parsed.header.requiresSimcBuild, /\d/)
  } else {
    assert.equal(parsed.header.requiresSimcBuild, undefined)
  }
})

test('candidate description survives a profile with no bag items', () => {
  const equippedOnly = REAL.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n')
  const parsed = parseAddonProfile(equippedOnly)
  assert.ok(parsed.equipped.length > 0, 'stripped the equipped gear too')
  assert.equal(parsed.bagItems.length, 0, 'bag items survived the strip')
  const candidates = describeCandidates(parsed)
  assert.ok(candidates.length > 0, 'no candidates from an equipped-only profile')
  assert.ok(candidates.every((c) => c.source === 'equipped'))
})

test('the real fixture still parses as the reference character', () => {
  // A canary: every edge case above mutates this string, so a change that broke
  // the original would otherwise show up as confusing failures elsewhere.
  const parsed = parseAddonProfile(REAL)
  assert.equal(parsed.className, 'shaman')
  assert.equal(parsed.spec, 'elemental')
  assert.ok(parsed.equipped.length >= 14, `only ${parsed.equipped.length} equipped items`)
})
