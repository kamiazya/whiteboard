import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withDaemonStartupLock } from '../daemon/daemon-lock.js'
import { parseDaemonRecord } from '../daemon/daemon-record.js'
import { loadDaemonRecord } from '../daemon/daemon-registry.js'
import {
  assertDataDirOwnedByUser,
  readFileOwnedByUserSync,
  refuseForeignRecordFile,
  resolveDataDir,
  secureDataDir,
} from './data-dir-secure.js'
import { ROOT_IS_SOMEONE_ELSES } from './test-utils/root-is-someone-elses.js'

describe('assertDataDirOwnedByUser', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-data-dir-owner-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('accepts a directory this user owns', () => {
    expect(() => assertDataDirOwnedByUser(dir, statSync(dir).uid)).not.toThrow()
  })

  it('refuses a directory another user owns', () => {
    expect(() => assertDataDirOwnedByUser(dir, statSync(dir).uid + 1)).toThrow(/not this user/)
  })

  it('accepts a directory that does not exist yet', () => {
    expect(() => assertDataDirOwnedByUser(join(dir, 'missing'), 0)).not.toThrow()
  })

  it('has nothing to compare where there is no uid', () => {
    expect(() => assertDataDirOwnedByUser(dir, undefined)).not.toThrow()
  })

  // Whoever owns a symlink can repoint it after the check, so the target
  // judged here is not the one written to later — and in the shared temp dir
  // that owner may be another user, aiming it at a dir of this user's.
  it.skipIf(process.platform === 'win32')('refuses a data dir that is a symlink', async () => {
    const real = join(dir, 'real')
    const linked = join(dir, 'linked')
    secureDataDir(real)
    await symlink(real, linked)
    expect(() => assertDataDirOwnedByUser(linked, statSync(real).uid)).toThrow(/symlink/)
    expect(() => secureDataDir(linked)).toThrow(/symlink/)
  })

  it.skipIf(process.platform === 'win32')(
    'leaves a symlinked data dir to the operator in operator trust',
    async () => {
      const real = join(dir, 'real')
      const linked = join(dir, 'linked')
      secureDataDir(real)
      await symlink(real, linked)
      expect(() => secureDataDir(linked, 'operator')).not.toThrow()
    },
  )
})

describe.skipIf(!ROOT_IS_SOMEONE_ELSES)('a data dir another user owns', () => {
  it('is not read for a daemon record', async () => {
    await expect(loadDaemonRecord('/')).rejects.toThrow(/not this user/)
  })

  it('is reported rather than parsed by status and doctor', async () => {
    const parsed = await parseDaemonRecord('/')
    expect(parsed).toMatchObject({
      kind: 'unreadable',
      error: expect.objectContaining({ message: expect.stringMatching(/not this user/) }),
    })
  })

  it('is not used to start a daemon', async () => {
    await expect(withDaemonStartupLock('/', async () => 'started')).rejects.toThrow(/not this user/)
  })
})

describe('the record file itself', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-record-owner-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // `O_NOFOLLOW` refuses the link before any owner is read, so this proves
  // the symlink refusal and not the owner check — that one is the pure
  // verdict below, since a file another user owns cannot be made here.
  it.skipIf(!ROOT_IS_SOMEONE_ELSES)(
    'is refused when it links to a file another user owns',
    async () => {
      await symlink('/etc/hostname', join(dir, 'daemon.json'))
      await expect(loadDaemonRecord(dir)).rejects.toThrow(/symlink/)
      expect(await parseDaemonRecord(dir)).toMatchObject({ kind: 'unreadable', recordFound: true })
    },
  )

  // A planted symlink to a file this user DOES own would pass an owner
  // check on the handle, so the record is never read through one.
  it('is refused when it is a symlink, even to a file this user owns', async () => {
    const elsewhere = join(dir, 'elsewhere.json')
    await writeFile(elsewhere, '{}')
    await symlink(elsewhere, join(dir, 'daemon.json'))
    await expect(loadDaemonRecord(dir)).rejects.toThrow(/symlink/)
    expect(await parseDaemonRecord(dir)).toMatchObject({ kind: 'unreadable', recordFound: true })
  })

  // A hard link is how a file this user owns could sit in a directory
  // someone else made; the record is only ever written by rename, so one
  // with a second name is not ours to trust.
  it('is refused when it has another hard link', async () => {
    const elsewhere = join(dir, 'elsewhere.json')
    await writeFile(elsewhere, '{}')
    await link(elsewhere, join(dir, 'daemon.json'))
    await expect(loadDaemonRecord(dir)).rejects.toThrow(/hard link/)
  })

  it('treats a directory gone once the file is open as refused, not absent', () => {
    expect(() =>
      assertDataDirOwnedByUser(join(dir, 'vanished'), statSync(dir).uid, { mustExist: true }),
    ).toThrow(/no longer exists/)
  })

  it('refuses a data dir anyone can write into, even one this user owns', async () => {
    await chmod(dir, 0o777)
    expect(() => assertDataDirOwnedByUser(dir, statSync(dir).uid)).toThrow(
      /writable by other users/,
    )
  })
  // Callers judge the directory before opening the file; this second look
  // covers a directory created or loosened between that check and the open.
  // It is mode-based, so unlike the uid arms it holds when the suite runs as root.
  it('is refused once open when its directory is writable by anyone', async () => {
    const path = join(dir, 'daemon.json')
    await writeFile(path, '{}')
    await chmod(dir, 0o777)
    expect(statSync(dir).mode & 0o002).not.toBe(0)
    expect(readFileOwnedByUserSync(path, statSync(dir).uid)).toEqual({
      kind: 'not-owned',
      message: expect.stringMatching(/writable by other users/),
    })
  })
})

describe('readFileOwnedByUserSync in a directory it cannot trust', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-record-untrusted-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // The directory is judged before anything in it is opened, so even an
  // absent record there is a refusal: absence is not something such a
  // directory can vouch for. Mode-based, so it holds when the suite runs as root.
  it('refuses before opening anything, an absent record included', async () => {
    await chmod(dir, 0o777)
    expect(readFileOwnedByUserSync(join(dir, 'server-mode.json'), statSync(dir).uid)).toEqual({
      kind: 'not-owned',
      message: expect.stringMatching(/writable by other users/),
    })
  })
})

/**
 * Whether this platform can make a FIFO. PROBED: a missing `mkfifo` binary or
 * a filesystem that refuses one is a premise the test cannot establish, which
 * is a skip, not a failure — and Windows has neither.
 */
function canMakeFifo(): boolean {
  if (process.platform === 'win32') return false
  const probeDir = mkdtempSync(join(tmpdir(), 'wb-fifo-probe-'))
  try {
    return spawnSync('mkfifo', [join(probeDir, 'p')]).status === 0
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}
const CAN_MAKE_FIFO = canMakeFifo()
const MCP_SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// A FIFO opened for reading blocks until a writer appears, and the read is
// synchronous, so a refusal that fails here would hang the worker rather than
// fail the test: it runs in a child with a deadline.
describe.skipIf(!CAN_MAKE_FIFO)('a record path that is not a regular file', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wb-record-fifo-'))
    await chmod(dir, 0o700)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses a FIFO planted as the record instead of waiting on it', () => {
    const path = join(dir, 'server-mode.json')
    expect(spawnSync('mkfifo', [path]).status).toBe(0)
    const module = pathToFileURL(join(MCP_SERVER_DIR, 'src/shared/data-dir-secure.ts')).href
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        '--input-type=module',
        '--eval',
        `const { readFileOwnedByUserSync } = await import(${JSON.stringify(module)})
process.stdout.write(JSON.stringify(readFileOwnedByUserSync(${JSON.stringify(path)})))`,
      ],
      { cwd: MCP_SERVER_DIR, encoding: 'utf8', timeout: 20_000 },
    )
    expect(child.signal, 'the read blocked on the FIFO').toBeNull()
    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({
      kind: 'not-owned',
      message: expect.stringMatching(/not a regular file/),
    })
  }, 30_000)
})

describe('resolveDataDir', () => {
  it('resolves a relative WHITEBOARD_DATA_DIR against the working directory', () => {
    expect(resolveDataDir({ WHITEBOARD_DATA_DIR: 'rel/dir' })).toBe(resolve('rel/dir'))
  })
})

describe('refuseForeignRecordFile', () => {
  const path = '/data/daemon.json'

  it('refuses a record file another user owns', () => {
    expect(refuseForeignRecordFile({ uid: 1000, nlink: 1 }, path, 1001)).toEqual({
      kind: 'not-owned',
      message: expect.stringMatching(/is owned by uid 1000, not this user \(uid 1001\)/),
    })
  })

  it('refuses a record file with a second name, even one this user owns', () => {
    expect(refuseForeignRecordFile({ uid: 1000, nlink: 2 }, path, 1000)).toEqual({
      kind: 'not-owned',
      message: expect.stringMatching(/another hard link/),
    })
  })

  it('accepts a record file this user owns under one name', () => {
    expect(refuseForeignRecordFile({ uid: 1000, nlink: 1 }, path, 1000)).toBeUndefined()
  })

  it('has nothing to compare where there is no uid', () => {
    expect(refuseForeignRecordFile({ uid: 1000, nlink: 3 }, path, undefined)).toBeUndefined()
  })
})
