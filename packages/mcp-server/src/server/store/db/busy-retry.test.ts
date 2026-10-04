import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { busyRetryingDialect } from './busy-retry.js'

let dir: string
let db: Kysely<unknown>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-busy-retry-'))
  db = new Kysely<unknown>({ dialect: busyRetryingDialect({ url: `file:${join(dir, 'x.db')}` }) })
  await sql`create table t (id integer primary key)`.execute(db)
})
afterEach(async () => {
  await db.destroy()
  await rm(dir, { recursive: true, force: true })
})

describe('the retrying dialect', () => {
  it('passes a failure that is not busy straight through, once', async () => {
    await sql`insert into t (id) values (1)`.execute(db)
    const error = await sql`insert into t (id) values (1)`.execute(db).catch((err: unknown) => err)
    expect(error).toMatchObject({ code: 'SQLITE_CONSTRAINT' })
    expect(error).not.toMatchObject({ name: 'DatabaseBusyError' })
  })

  it('reads and writes as the plain dialect does', async () => {
    await sql`insert into t (id) values (7)`.execute(db)
    const rows = await sql<{ id: number }>`select id from t`.execute(db)
    expect(rows.rows).toEqual([{ id: 7 }])
  })

  it('commits a transaction and rolls one back', async () => {
    await db.transaction().execute((trx) => sql`insert into t (id) values (1)`.execute(trx))
    await db
      .transaction()
      .execute(async (trx) => {
        await sql`insert into t (id) values (2)`.execute(trx)
        throw new Error('abort')
      })
      .catch(() => undefined)
    const rows = await sql<{ id: number }>`select id from t order by id`.execute(db)
    expect(rows.rows).toEqual([{ id: 1 }])
  })
})
