import { statSync } from 'node:fs'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withDaemonStartupLock } from '../daemon/daemon-lock.js'
import { parseDaemonRecord } from '../daemon/daemon-record.js'
import { loadDaemonRecord } from '../daemon/daemon-registry.js'
import { assertDataDirOwnedByUser } from './data-dir-secure.js'

// Probed rather than assumed: `/` belongs to another user only when this
// process is not root, and Windows has no uid to compare.
const uid = process.getuid?.()
const ROOT_IS_SOMEONE_ELSES = uid !== undefined && statSync('/').uid !== uid

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

  // Checked on the OPENED file, so a record that appears after the directory
  // check — in a directory that was missing then — is judged too.
  it.skipIf(!ROOT_IS_SOMEONE_ELSES)('is refused when another user owns it', async () => {
    await symlink('/etc/hostname', join(dir, 'daemon.json'))
    await expect(loadDaemonRecord(dir)).rejects.toThrow(/not this user|symlink/)
    expect(await parseDaemonRecord(dir)).toMatchObject({ kind: 'malformed' })
  })

  // A planted symlink to a file this user DOES own would pass an owner
  // check on the handle, so the record is never read through one.
  it('is refused when it is a symlink, even to a file this user owns', async () => {
    const elsewhere = join(dir, 'elsewhere.json')
    await writeFile(elsewhere, '{}')
    await symlink(elsewhere, join(dir, 'daemon.json'))
    await expect(loadDaemonRecord(dir)).rejects.toThrow(/symlink/)
    expect(await parseDaemonRecord(dir)).toMatchObject({ kind: 'malformed' })
  })

  it('refuses a data dir anyone can write into, even one this user owns', async () => {
    await chmod(dir, 0o777)
    expect(() => assertDataDirOwnedByUser(dir, statSync(dir).uid)).toThrow(
      /writable by other users/,
    )
  })
})
