import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pathExists } from '../../shared/test-utils/path-exists.js'
import { captureLogsForTests } from '../log.js'
import { performBackup } from './backup-pass.js'
import { DB_URL_ENV } from './db/location.js'

let root: string
let dataDir: string
let backupRoot: string

beforeEach(async () => {
  // Resolved, so a platform whose temp dir is itself a symlink does not turn
  // every case into an ancestor-symlink case.
  root = await realpath(await mkdtemp(join(tmpdir(), 'wb-backup-pass-')))
  dataDir = join(root, 'data')
  backupRoot = join(root, 'backups')
  await mkdir(dataDir, { recursive: true })
  await mkdir(backupRoot, { recursive: true })
  await writeFile(join(dataDir, 'notes.txt'), 'data')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A pass whose copy step would report being reached, so a refusal can be told from a later failure. */
function spyOnCopy(): { reached: () => boolean; doBackup: () => Promise<void> } {
  let reached = false
  return {
    reached: () => reached,
    doBackup: async () => {
      reached = true
    },
  }
}

describe('the paths a backup pass refuses before doing any work', () => {
  it('refuses an output path that is a symlink to a file', async () => {
    const target = join(root, 'a-file')
    await writeFile(target, 'x')
    const outputDir = join(backupRoot, 'link')
    await symlink(target, outputDir)
    const copy = spyOnCopy()

    const outcome = await performBackup({
      dataDir,
      outputDir,
      mirrorRoot: backupRoot,
      doBackup: copy.doBackup,
    })

    // Not `error`: a symlink is a refused PATH, and the operator is told so
    // rather than being told the pass failed.
    expect(outcome.kind).toBe('invalid-output-path')
    expect(copy.reached()).toBe(false)
  })

  it('refuses an output path that is a symlink to a directory, and writes nothing through it', async () => {
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere)
    const outputDir = join(backupRoot, 'link')
    await symlink(elsewhere, outputDir)
    const copy = spyOnCopy()

    const outcome = await performBackup({
      dataDir,
      outputDir,
      mirrorRoot: backupRoot,
      doBackup: copy.doBackup,
    })

    expect(outcome.kind).toBe('invalid-output-path')
    expect(copy.reached()).toBe(false)
    expect(await pathExists(join(elsewhere, 'blobs.json'))).toBe(false)
  })

  it('refuses a data directory reached through a symlink', async () => {
    const linked = join(root, 'linked-data')
    await symlink(dataDir, linked)
    const copy = spyOnCopy()

    const outcome = await performBackup({
      dataDir: linked,
      outputDir: join(backupRoot, 'night'),
      mirrorRoot: backupRoot,
      doBackup: copy.doBackup,
    })

    expect(outcome).toEqual({ kind: 'error', message: 'backup failed' })
    expect(copy.reached()).toBe(false)
  })
})

describe('what a finished pass says about the stores it captured', () => {
  it('says the rows were not captured when the database is hosted elsewhere', async () => {
    const outcome = await performBackup({
      dataDir,
      outputDir: join(backupRoot, 'night'),
      mirrorRoot: backupRoot,
      env: { [DB_URL_ENV]: 'libsql://rows.example.test' },
    })

    expect(outcome.kind).toBe('ok')
    expect(outcome.kind === 'ok' && outcome.result.stores).toEqual({
      database: { captured: false, reason: 'hosted-elsewhere' },
      blobs: { captured: true },
    })
  })
})

describe('a pass whose blob mirror fails', () => {
  it('reports the mirror and does not go on to log a failed seal', async () => {
    const logs = captureLogsForTests('debug')
    try {
      const outcome = await performBackup({
        dataDir,
        outputDir: join(backupRoot, 'night'),
        mirrorRoot: backupRoot,
        env: { [DB_URL_ENV]: 'libsql://rows.example.test' },
        doMirror: async () => {
          throw new Error('the mirror could not be written')
        },
      })

      expect(outcome.kind).toBe('error')
      const messages = logs.records.map((record) => record.msg)
      expect(messages).toContain('could not mirror the blobs; the backup is not usable')
      expect(messages).not.toContain('could not put the finished backup in place')
    } finally {
      logs.restore()
    }
  })
})
