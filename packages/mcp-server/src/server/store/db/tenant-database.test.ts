import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../../shared/test-utils/fast-check.js'
import { tenantDatabase } from './tenant-database.js'
import { SELF_HOST_TENANT_ID, TENANT_SCOPED_TABLES } from './tenant-scope.js'
import { createIsolatedDb } from './test-helpers.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-tenant-db-'))
  handle = await createIsolatedDb({ dataDir: root })
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('the schema carries what the ledger says', () => {
  it('every tenant-scoped table has a tenantId column, and no keeper-wide one does', async () => {
    const tables = await sql<{ name: string }>`
      select name from sqlite_master
      where type = 'table' and name not like 'sqlite_%' and name not like 'kysely_%'
    `.execute(handle.rawDb)
    const withTenant: string[] = []
    for (const { name } of tables.rows) {
      const cols = await sql<{ name: string }>`select name from pragma_table_info(${name})`.execute(
        handle.rawDb,
      )
      if (cols.rows.some((c) => c.name === 'tenantId')) withTenant.push(name)
    }
    expect(tables.rows.length).toBeGreaterThan(10)
    expect(withTenant.sort()).toEqual([...TENANT_SCOPED_TABLES].sort())
  })

  it('a database holds exactly one tenant row, the self-host one, after migrating', async () => {
    const rows = await handle.rawDb.selectFrom('tenants').select('id').execute()
    expect(rows).toEqual([{ id: SELF_HOST_TENANT_ID }])
  })
})

type Op =
  | { kind: 'insert'; tenant: 0 | 1; key: number; value: number }
  | { kind: 'update'; tenant: 0 | 1; key: number; value: number }
  | { kind: 'delete'; tenant: 0 | 1; key: number }
  | { kind: 'deleteAll'; tenant: 0 | 1 }

// Few keys, so the two tenants keep reaching for the same ones: a property
// where the tenants never touch the same key cannot tell a filter from none.
const keyArb = fc.integer({ min: 0, max: 3 })
const tenantArb = fc.constantFrom<0 | 1>(0, 1)
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('insert' as const),
    tenant: tenantArb,
    key: keyArb,
    value: fc.nat(1000),
  }),
  fc.record({
    kind: fc.constant('update' as const),
    tenant: tenantArb,
    key: keyArb,
    value: fc.nat(1000),
  }),
  fc.record({ kind: fc.constant('delete' as const), tenant: tenantArb, key: keyArb }),
  fc.record({ kind: fc.constant('deleteAll' as const), tenant: tenantArb }),
)

describe('a tenant-bound handle', () => {
  let crossTenantTouches = 0

  // afterAll, not afterEach: @fast-check/vitest runs each-hooks around every
  // generated case, where the count is still zero on the first one.
  afterAll(() => {
    // The property is vacuous unless the two tenants actually reached for
    // rows the other one held; this is the count that says they did.
    expect(crossTenantTouches).toBeGreaterThan(0)
  })

  fcTest.prop([fc.array(opArb, { maxLength: 25 })], withDefaults({ numRuns: 40 }))(
    'never reads, changes or removes another tenant rows',
    async (ops) => {
      await handle.rawDb.deleteFrom('workspaceMemberships').execute()
      const tenants = [SELF_HOST_TENANT_ID, 'tenant-two'] as const
      const dbs = tenants.map((t) => tenantDatabase(handle.rawDb, t))
      // key -> [owner, createdAt]; the primary key is global, so a key held by
      // either tenant refuses the other's insert.
      const model = new Map<number, { owner: 0 | 1; value: number }>()
      for (const op of ops) {
        const db = dbs[op.tenant]
        const held = 'key' in op ? model.get(op.key) : undefined
        if (held && held.owner !== op.tenant) crossTenantTouches++
        if (op.kind === 'insert') {
          const insert = db
            .insertInto('workspaceMemberships')
            .values({ workspaceId: `ws-${op.key}`, profileId: 'p', createdAt: op.value })
          if (held) await expect(insert.execute()).rejects.toThrow()
          else {
            await insert.execute()
            model.set(op.key, { owner: op.tenant, value: op.value })
          }
        } else if (op.kind === 'update') {
          await db
            .updateTable('workspaceMemberships')
            .set({ createdAt: op.value })
            .where('workspaceId', '=', `ws-${op.key}`)
            .execute()
          if (held?.owner === op.tenant) held.value = op.value
        } else if (op.kind === 'delete') {
          await db
            .deleteFrom('workspaceMemberships')
            .where('workspaceId', '=', `ws-${op.key}`)
            .execute()
          if (held?.owner === op.tenant) model.delete(op.key)
        } else {
          await db.deleteFrom('workspaceMemberships').execute()
          for (const [key, row] of [...model]) if (row.owner === op.tenant) model.delete(key)
        }
        for (const tenant of [0, 1] as const) {
          const seen = await dbs[tenant]
            .selectFrom('workspaceMemberships')
            .select(['workspaceId', 'createdAt'])
            .orderBy('workspaceId')
            .execute()
          const expected = [...model]
            .filter(([, row]) => row.owner === tenant)
            .sort(([a], [b]) => a - b)
            .map(([key, row]) => ({ workspaceId: `ws-${key}`, createdAt: row.value }))
          expect(seen).toEqual(expected)
        }
      }
    },
  )
})

describe('what a tenant-bound handle scopes beyond a plain statement', () => {
  async function seedTwoTenants(): Promise<void> {
    const [a, b] = [SELF_HOST_TENANT_ID, 'tenant-two'].map((t) => tenantDatabase(handle.rawDb, t))
    await a
      .insertInto('memberProfiles')
      .values({ id: 'pa', displayName: 'A', createdAt: 1, updatedAt: 1 })
      .execute()
    await b
      .insertInto('memberProfiles')
      .values({ id: 'pb', displayName: 'B', createdAt: 1, updatedAt: 1 })
      .execute()
    await a
      .insertInto('workspaceMemberships')
      .values({ workspaceId: 'ws-a', profileId: 'pb', createdAt: 1 })
      .execute()
  }

  it('scopes a joined table in its ON, so a left join does not become an inner one', async () => {
    await seedTwoTenants()
    const a = tenantDatabase(handle.rawDb, SELF_HOST_TENANT_ID)
    // Tenant A's membership names tenant B's profile id: the join must not
    // reach across, and the membership row must still come back.
    const rows = await a
      .selectFrom('workspaceMemberships')
      .leftJoin('memberProfiles', 'memberProfiles.id', 'workspaceMemberships.profileId')
      .select(['workspaceMemberships.workspaceId', 'memberProfiles.displayName'])
      .execute()
    expect(rows).toEqual([{ workspaceId: 'ws-a', displayName: null }])
  })

  it('scopes a subquery', async () => {
    await seedTwoTenants()
    const a = tenantDatabase(handle.rawDb, SELF_HOST_TENANT_ID)
    const rows = await a
      .selectFrom('workspaceMemberships')
      .select('workspaceId')
      .where('profileId', 'in', (eb) => eb.selectFrom('memberProfiles').select('id'))
      .execute()
    expect(rows).toEqual([])
  })

  it('an upsert does not overwrite a row another tenant holds under the same key', async () => {
    await seedTwoTenants()
    const b = tenantDatabase(handle.rawDb, 'tenant-two')
    await b
      .insertInto('workspaceMemberships')
      .values({ workspaceId: 'ws-a', profileId: 'pb', createdAt: 99 })
      .onConflict((oc) => oc.columns(['workspaceId', 'profileId']).doUpdateSet({ createdAt: 99 }))
      .execute()
    const a = tenantDatabase(handle.rawDb, SELF_HOST_TENANT_ID)
    const rows = await a.selectFrom('workspaceMemberships').select('createdAt').execute()
    expect(rows).toEqual([{ createdAt: 1 }])
  })

  it('hands back rows without the tenant column, the shape the schema type declares', async () => {
    const a = tenantDatabase(handle.rawDb, SELF_HOST_TENANT_ID)
    await a.insertInto('workspaceMembersOnly').values({ workspaceId: 'w', since: 1 }).execute()
    expect(await a.selectFrom('workspaceMembersOnly').selectAll().execute()).toEqual([
      { workspaceId: 'w', since: 1 },
    ])
  })

  it('leaves a keeper-wide table alone', async () => {
    const a = tenantDatabase(handle.rawDb, 'tenant-two')
    await a.insertInto('leases').values({ name: 'backup', holder: 'x', expiresAt: 1 }).execute()
    const rows = await handle.rawDb.selectFrom('leases').select('name').execute()
    expect(rows).toEqual([{ name: 'backup' }])
  })
})

describe('what a tenant-bound handle refuses rather than guessing', () => {
  it('an insert that names the tenant itself', async () => {
    const a = tenantDatabase(handle.rawDb, SELF_HOST_TENANT_ID)
    await expect(
      a
        .insertInto('workspaceMembersOnly')
        .values({ workspaceId: 'w', since: 1, tenantId: 'other' } as any)
        .execute(),
    ).rejects.toThrow(/tenantId/)
  })

  it('an update that moves a row to another tenant', async () => {
    const a = tenantDatabase(handle.rawDb, SELF_HOST_TENANT_ID)
    await expect(
      a
        .updateTable('workspaceMembersOnly')
        .set({ tenantId: 'other' } as any)
        .execute(),
    ).rejects.toThrow(/tenantId/)
  })

  it('an insert from a select into a tenant-scoped table', async () => {
    const a = tenantDatabase(handle.rawDb, SELF_HOST_TENANT_ID)
    await expect(
      a
        .insertInto('workspaceMembersOnly')
        .columns(['workspaceId', 'since'])
        .expression((eb) =>
          eb.selectFrom('workspaceMemberships').select(['workspaceId', 'createdAt']),
        )
        .execute(),
    ).rejects.toThrow(/insert from a select/)
  })
})
