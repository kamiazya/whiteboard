// `DatabaseSchema` is a hand-written claim about what the migrations build, and
// Kysely trusts it: a column it names that the database lacks fails at the first
// query, and one the database has that it omits is invisible to every typed
// store. Nothing else compares the two, so this does — in both directions —
// against the database the migrations actually produce. The claim itself is
// `schema-ledger.ts`, which tsc holds to the schema; this reads the physical
// side through `pragma_table_info`.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSchema } from './schema.js'
import { LEDGER, NULLABLE_IN_DATABASE, type SqlType } from './schema-ledger.js'
import { TENANT_SCOPED_TABLES } from './tenant-scope.js'
import { createIsolatedDb, type IsolatedDbHandle } from './test-helpers.js'

type SqlTypeClaim = { readonly type: SqlType; readonly nullable: boolean }

interface PhysicalColumn {
  readonly type: string
  readonly nullable: boolean
}

// A single-column PRIMARY KEY reports `notnull = 0` in SQLite, which is a
// legacy of the format and says nothing about whether a row may lack one, so
// a key column is read as not nullable.
async function physicalColumns(
  handle: IsolatedDbHandle,
  table: string,
): Promise<Map<string, PhysicalColumn>> {
  const rows = await sql<{ name: string; type: string; notnull: number; pk: number }>`
    select name, type, "notnull", pk from pragma_table_info(${table})
  `.execute(handle.rawDb)
  return new Map(
    rows.rows.map((r) => [r.name, { type: r.type, nullable: r.notnull === 0 && r.pk === 0 }]),
  )
}

const tables = Object.keys(LEDGER) as (keyof DatabaseSchema)[]

let root: string
let handle: IsolatedDbHandle

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-schema-conformance-'))
  handle = await createIsolatedDb({ dataDir: root })
})

afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('DatabaseSchema against the migrated database', () => {
  it('names exactly the tables the migrations create', async () => {
    const rows = await sql<{ name: string }>`
      select name from sqlite_master
      where type = 'table' and name not like 'sqlite_%' and name not like 'kysely_%'
    `.execute(handle.rawDb)
    expect(tables.length).toBeGreaterThan(10)
    expect(rows.rows.map((r) => r.name).sort()).toEqual([...tables].sort())
  })

  it.each(
    tables,
  )('%s: every column is declared, and every declared column exists', async (table) => {
    const physical = await physicalColumns(handle, table)
    // `tenantId` is physical on a tenant-scoped table and deliberately absent
    // from the schema: the tenant-bound handle stamps and strips it.
    const declared = [
      ...Object.keys(LEDGER[table]),
      ...(TENANT_SCOPED_TABLES.has(table) ? ['tenantId'] : []),
    ]
    expect([...physical.keys()].sort()).toEqual(declared.sort())
  })

  it.each(
    tables,
  )('%s: each column has the storage class and nullability claimed', async (table) => {
    const physical = await physicalColumns(handle, table)
    const claims = LEDGER[table] as Record<string, SqlTypeClaim>
    const exempt = (NULLABLE_IN_DATABASE[table] ?? {}) as Record<string, string>
    for (const [column, claim] of Object.entries(claims)) {
      const actual = physical.get(column)
      expect(actual?.type, `${table}.${column} storage class`).toBe(claim.type)
      const expectedNullable = claim.nullable || column in exempt
      expect(actual?.nullable, `${table}.${column} nullable`).toBe(expectedNullable)
    }
  })

  it('every exempted column is declared NOT NULL by the schema yet nullable in the database', async () => {
    const exemptions = Object.entries(NULLABLE_IN_DATABASE).flatMap(([table, columns]) =>
      Object.keys(columns).map((column) => ({ table: table as keyof DatabaseSchema, column })),
    )
    expect(exemptions.length).toBeGreaterThan(0)
    for (const { table, column } of exemptions) {
      const claim = (LEDGER[table] as Record<string, SqlTypeClaim>)[column]
      expect(claim?.nullable, `${table}.${column} is claimed nullable and exempted`).toBe(false)
      expect((await physicalColumns(handle, table)).get(column)?.nullable).toBe(true)
    }
  })
})
