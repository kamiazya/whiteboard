import { statSync } from 'node:fs'
import { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withDaemonStartupLock } from '../daemon/daemon-lock.js'
import { parseDaemonRecord } from '../daemon/daemon-record.js'
import { loadDaemonRecord } from '../daemon/daemon-registry.js'
import { assertDataDirOwnedByUser, refuseForeignRecordFile } from './data-dir-secure.js'
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
})

describe.skipIf(!ROOT_IS_SOMEONE_ELSES)('a data dir another user owns', () => {
  it('is not read for a daemon record', async () => {
    await expect(loadDaemonRecord('/')).rejects.toThrow(/not this user/)
  })

  it('is reported rather than parsed by status and doctor', async () => {
    const parsed = await parseDaemonRecord('/')
    expect(parsed).toMatchObject({
      kind: 'malformed',
      message: expect.stringMatching(/not this user/),
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
      expect(await parseDaemonRecord(dir)).toMatchObject({ kind: 'malformed' })
    },
  )

  // A planted symlink to a file this user DOES own would pass an owner
  // check on the handle, so the record is never read through one.
  it('is refused when it is a symlink, even to a file this user owns', async () => {
    const elsewhere = join(dir, 'elsewhere.json')
    await writeFile(elsewhere, '{}')
    await symlink(elsewhere, join(dir, 'daemon.json'))
    await expect(loadDaemonRecord(dir)).rejects.toThrow(/symlink/)
    expect(await parseDaemonRecord(dir)).toMatchObject({ kind: 'malformed' })
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
