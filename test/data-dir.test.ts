import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWritable, localAppDataDir, resolveDataDir } from '../src/core/dataDir.ts'

/**
 * Where the app writes.
 *
 * This decision only ever misbehaves on a machine you do not own — Program
 * Files, a read-only stick, a network share — so it is tested directly rather
 * than left to be discovered by whoever unzips the release.
 *
 * An unwritable location is simulated by pointing at a path *underneath a
 * regular file*: mkdir then fails with ENOTDIR on every platform, with no need
 * for ACLs or an elevated test run.
 */

async function sandbox(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'simitboi-datadir-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A path that cannot be created, because a file sits where a directory must go. */
async function blocked(root: string, name: string): Promise<string> {
  const file = join(root, name)
  await writeFile(file, 'not a directory')
  return join(file, 'nested')
}

test('a writable directory is proven by writing, not by asking', async (t) => {
  const root = await sandbox(t)
  assert.equal(isWritable(join(root, 'fresh')), true)
  // The probe file must not survive the check.
  assert.deepEqual(await readdir(join(root, 'fresh')), [])

  const impossible = await blocked(root, 'a-file')
  const why = isWritable(impossible)
  assert.notEqual(why, true, 'a path under a file was reported writable')
  assert.match(String(why), /ENOTDIR|ENOENT|EEXIST/)
})

test('the portable folder beside the executable is preferred', async (t) => {
  const root = await sandbox(t)
  const exeDir = join(root, 'SimItBoi')
  const choice = resolveDataDir({
    isPackaged: true, exeDir, electronAppData: join(root, 'roaming')
  })
  assert.equal(choice.dir, join(exeDir, 'data'))
  assert.equal(choice.portable, true)
  assert.equal(choice.fellBack, false)
  assert.equal(choice.reason, null)
})

test('an unwritable install falls back, and says why', async (t) => {
  const root = await sandbox(t)
  const exeDir = await blocked(root, 'program-files')
  const appData = join(root, 'roaming')
  const choice = resolveDataDir({ isPackaged: true, exeDir, electronAppData: appData })

  assert.equal(choice.fellBack, true)
  assert.equal(choice.portable, true)
  assert.notEqual(choice.dir, join(exeDir, 'data'))
  assert.ok(choice.reason && choice.reason.includes('not writable'),
    'the fallback did not explain itself: ' + choice.reason)
  // And the chosen directory really is usable, not merely different.
  assert.equal(isWritable(choice.dir), true)
})

test('nowhere to write is an error, not a silent start', async (t) => {
  const root = await sandbox(t)
  const exeDir = await blocked(root, 'install')
  const appData = await blocked(root, 'appdata')
  // On Windows the fallback reads LOCALAPPDATA rather than Electron's answer,
  // so blocking only the argument would leave a perfectly good real directory
  // to fall back to and nothing would be proven.
  const before = process.env['LOCALAPPDATA']
  try {
    process.env['LOCALAPPDATA'] = await blocked(root, 'localappdata')
    assert.throws(
      () => resolveDataDir({ isPackaged: true, exeDir, electronAppData: appData }),
      /nowhere to store its data/
    )
  } finally {
    if (before === undefined) delete process.env['LOCALAPPDATA']
    else process.env['LOCALAPPDATA'] = before
  }
})

test('the fallback is LOCALAPPDATA on Windows, not roaming APPDATA', () => {
  const roaming = join('C:', 'Users', 'x', 'AppData', 'Roaming')
  const local = join('C:', 'Users', 'x', 'AppData', 'Local')
  const before = process.env['LOCALAPPDATA']
  try {
    process.env['LOCALAPPDATA'] = local
    const chosen = localAppDataDir(roaming)
    if (process.platform === 'win32') {
      // A 116 MB simulator must not copy itself across a domain network on
      // every login, which is what the roaming profile would do.
      assert.equal(chosen, join(local, 'SimItBoi'))
      assert.ok(!chosen.includes('Roaming'), 'the roaming profile was chosen')
    } else {
      assert.equal(chosen, join(roaming, 'SimItBoi'))
    }

    // An empty or absent LOCALAPPDATA falls back rather than producing a
    // relative path that would land wherever the process happened to start.
    process.env['LOCALAPPDATA'] = ''
    assert.equal(localAppDataDir(roaming), join(roaming, 'SimItBoi'))
  } finally {
    if (before === undefined) delete process.env['LOCALAPPDATA']
    else process.env['LOCALAPPDATA'] = before
  }
})

test('development ignores both and uses the requested directory', async (t) => {
  const root = await sandbox(t)
  const dev = join(root, 'dev-data')
  const choice = resolveDataDir({
    isPackaged: false, exeDir: join(root, 'unused'),
    electronAppData: join(root, 'unused'), devDir: dev
  })
  assert.equal(choice.dir, dev)
  assert.equal(choice.portable, false)
  assert.equal(choice.fellBack, false)
  assert.equal(isWritable(dev), true)
})

test('spaces and non-ASCII in the path are not special', async (t) => {
  const root = await sandbox(t)
  const exeDir = join(root, 'WoW Stuff', 'Sim It Boi é測試')
  const choice = resolveDataDir({
    isPackaged: true, exeDir, electronAppData: join(root, 'roaming')
  })
  assert.equal(choice.fellBack, false, 'a path with spaces and non-ASCII was rejected')
  assert.equal(choice.dir, join(exeDir, 'data'))
  assert.equal(isWritable(choice.dir), true)
})
