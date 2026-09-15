import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  DATA_FILES, combinedIdentity, dataIdentities, dataIdentity, validateDataSnapshot
} from '../src/core/data/manifest.ts'

const require_ = createRequire(import.meta.url)

/** See src/core/data/manifest.ts for why each of these is checked. */

test('every declared data file exists and is valid', () => {
  assert.deepEqual(validateDataSnapshot(), [], 'the shipped snapshot has problems')
})

test('the manifest declares every data file the code requires', () => {
  // The dawncrest-crafts.json packaging break happened because a file the code
  // required was absent from the build's emit list. Scan the sources for runtime
  // JSON requires and assert the manifest covers each one.
  const sources = ['catalog.ts', 'crafted.ts', 'db2.ts', 'itemTable.ts']
  const required = new Set<string>()
  for (const file of sources) {
    const text = readFileSync(`src/core/data/${file}`, 'utf8')
    for (const match of text.matchAll(/require_?\(\s*'\.\/([\w-]+\.json)'/g)) {
      required.add(match[1]!)
    }
  }
  assert.ok(required.size > 0, 'found no runtime JSON requires to check')
  for (const file of required) {
    assert.ok(
      (DATA_FILES as readonly string[]).includes(file),
      `${file} is required at runtime but not declared in DATA_FILES, so the build will not ship it`
    )
  }
})

test('the bundler emit list is the manifest, not a second hand-kept list', () => {
  // If the config ever names a data file literally again, the two lists can
  // drift, which is the failure this is here to prevent.
  const config = readFileSync('electron.vite.config.ts', 'utf8')
  assert.match(config, /for \(const file of DATA_FILES\)/)
  for (const file of DATA_FILES) {
    assert.ok(!config.includes(`'${file}'`), `${file} is named literally in the bundler config`)
  }
})

test('identity is the content hash, and stable', () => {
  for (const file of DATA_FILES) {
    const identity = dataIdentity(file)
    assert.match(identity, /^sha256:[0-9a-f]{12}$/, `${file}: ${identity}`)
    assert.equal(identity, dataIdentity(file), 'identity is not stable across calls')
  }
  const identities = dataIdentities()
  assert.equal(Object.keys(identities).length, DATA_FILES.length)
  // Distinct files must not collide, or a run envelope cannot tell them apart.
  assert.equal(new Set(Object.values(identities)).size, DATA_FILES.length)
})

test('a combined identity depends on content, not order', () => {
  const pair = combinedIdentity(['season1-gear.json', 'season2-gear.json'])
  assert.equal(pair, combinedIdentity(['season2-gear.json', 'season1-gear.json']))
  assert.notEqual(pair, combinedIdentity(['season1-gear.json']))
  assert.match(pair, /^sha256:[0-9a-f]{12}$/)
})

test('identity tracks the bytes, so an identical rebuild keeps it', () => {
  // The whole point of replacing timestamps: hashing the same bytes twice must
  // give the same id, and different bytes must not.
  const path = require_.resolve('../src/core/data/db2.json')
  const bytes = readFileSync(path)
  const { createHash } = require_('node:crypto') as typeof import('node:crypto')
  const expected = `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`
  assert.equal(dataIdentity('db2.json'), expected)
})

test('the icon map covers the reference export', () => {
  // The map is generated, but its generator's fixture-coverage step once failed
  // silently: a mangled regex matched nothing, so the reference export's own
  // gear quietly lost its icons. This asserts the outcome rather than the code.
  const icons = require_('../src/renderer/src/item-icons.json') as Record<string, string>
  const profile = readFileSync('fixtures/vahshandooz-elemental.simc', 'utf8')
  const ids = [...new Set([...profile.matchAll(/,id=([0-9]+)/g)].map((m) => m[1]!))]
  assert.ok(ids.length > 50, `only found ${ids.length} item ids in the fixture`)
  const missing = ids.filter((id) => !icons[id])
  assert.deepEqual(missing, [], 'reference export items without an icon mapping')
})
