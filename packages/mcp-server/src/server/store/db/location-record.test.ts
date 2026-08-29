import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDatabaseLocationRecord, writeDatabaseLocationRecord } from './location-record.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-location-record-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * The one durable answer to "where does this deployment keep its rows".
 *
 * Every other source fails the case it is needed for. The environment belongs
 * to whoever runs the command — `whiteboard server backup` runs host-side,
 * where a container's `--env-file` is not loaded. The directory answers only
 * "a file is here", which a stale `whiteboard.db` left behind by a migration
 * satisfies while the real rows live in libSQL. And `server-mode.json` is
 * deleted on graceful shutdown, which the documented backup flow performs
 * first.
 *
 * So this is written by whoever OPENS the database, and is deliberately not
 * removed on shutdown — being readable after the server is stopped is the
 * entire point.
 */
describe('the database location record', () => {
  it('is absent before anything has opened a database', async () => {
    expect(await readDatabaseLocationRecord(dir)).toBeNull()
  })

  it('round-trips both answers', async () => {
    await writeDatabaseLocationRecord(dir, true)
    expect(await readDatabaseLocationRecord(dir)).toEqual({ inDataDir: true })
    await writeDatabaseLocationRecord(dir, false)
    expect(await readDatabaseLocationRecord(dir)).toEqual({ inDataDir: false })
  })

  /**
   * Never the URL. It can carry userinfo, this file sits in the data
   * directory a backup copies, and the only question anyone asks of it is a
   * boolean.
   */
  it('records no connection string', async () => {
    await writeDatabaseLocationRecord(dir, false)
    const raw = await readFile(join(dir, 'storage.json'), 'utf8')
    expect(raw).not.toMatch(/libsql|https?:|token|@/i)
  })

  /**
   * Fail closed on anything unreadable: `null` sends the caller back to the
   * weaker env-and-directory answer, which is what it had before this record
   * existed — never to a confident "it is local".
   */
  it('reads as absent when the file is corrupt or the wrong shape', async () => {
    await writeFile(join(dir, 'storage.json'), 'not json')
    expect(await readDatabaseLocationRecord(dir)).toBeNull()
    await writeFile(join(dir, 'storage.json'), JSON.stringify({ schemaVersion: 1 }))
    expect(await readDatabaseLocationRecord(dir)).toBeNull()
    await writeFile(join(dir, 'storage.json'), JSON.stringify({ schemaVersion: 99, database: {} }))
    expect(await readDatabaseLocationRecord(dir)).toBeNull()
  })

  /** Writing must never be able to stop a server from starting. */
  it('swallows a write it cannot perform', async () => {
    await expect(
      writeDatabaseLocationRecord(join(dir, 'does', 'not', 'exist'), true),
    ).resolves.toBeUndefined()
  })
})
