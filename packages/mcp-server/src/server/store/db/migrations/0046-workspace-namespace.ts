import { deriveUserHandle, generateDocumentId } from '@kamiazya/whiteboard-model'
import { firstFreeSegment } from '@kamiazya/whiteboard-workspace-index'
import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// ADR-0053: a workspace segment is unique within the NAMESPACE that holds the
// workspace, not across the keeper, so a segment held in someone else's
// namespace can no longer be learned from a rename's 409 or a create's `-2`.
//
// Three steps, in an order each depends on:
//
// 1. Every tenant user gets a handle, unique per (tenantId, handle): their
//    display name through `deriveUserHandle`, suffixed by `firstFreeSegment`
//    in the order users joined (createdAt, then id). The derivation is
//    imported rather than frozen because any valid, unique handle satisfies
//    this step; what is frozen is the order, which decides who keeps the
//    unsuffixed one.
// 2. Every workspace gets a namespace: the handle of its earliest OWNER
//    (membership createdAt, ties by user id — the rule ADR-0053 decision 4
//    uses when a holder is deleted). A workspace with no membership at all
//    goes to `me`, the single-person namespace: on the local daemon that is
//    every workspace, and on server mode a workspace nobody is a member of
//    admits nobody, so `me` — which no server-mode user can hold — leaves it
//    reachable by its id alone until an operator grants it a member. A
//    workspace that HAS members but no owner is refused: inventing a holder
//    would hand one person's address space to somebody the keeper never
//    chose. An owner row whose user no longer exists has no handle to give,
//    and lands in `me` like a memberless workspace.
// 3. `workspaces_segment_unique` (0018), keeper-wide and across tenants, is
//    replaced by one on (tenantId, namespace, segment).
//
// ponytail: `handle` is nullable at the column (SQLite's ADD COLUMN takes no
// NOT NULL without a default); every row is filled here and every insert the
// store makes carries one. `namespace` is NOT NULL DEFAULT 'me', so a raw
// insert lands in the single-person namespace rather than failing.
const SINGLE_PERSON_NAMESPACE = 'me'

interface MigrationSchema {
  memberProfiles: {
    id: string
    displayName: string
    createdAt: number
    tenantId: string
    handle: string | null
  }
  workspaces: { id: string; tenantId: string; namespace: string }
  workspaceMemberships: {
    workspaceId: string
    profileId: string
    createdAt: number
    role: string | null
    tenantId: string
  }
}

async function mintHandles(db: Kysely<MigrationSchema>): Promise<void> {
  const users = await db
    .selectFrom('memberProfiles')
    .select(['id', 'displayName', 'tenantId'])
    .orderBy('tenantId')
    .orderBy('createdAt')
    .orderBy('id')
    .execute()
  const held = new Map<string, Set<string>>()
  for (const user of users) {
    const inTenant = held.get(user.tenantId) ?? new Set<string>()
    held.set(user.tenantId, inTenant)
    const handle =
      (await firstFreeSegment(deriveUserHandle(user.displayName), (h) => inTenant.has(h))) ??
      `user-${generateDocumentId().toLowerCase()}`
    inTenant.add(handle)
    await db.updateTable('memberProfiles').set({ handle }).where('id', '=', user.id).execute()
  }
}

async function placeWorkspaces(db: Kysely<MigrationSchema>): Promise<void> {
  const ownerless = await sql<{ workspaceId: string }>`
    select distinct m.workspaceId from workspaceMemberships m
    join workspaces w on w.id = m.workspaceId and w.tenantId = m.tenantId
    where not exists (
      select 1 from workspaceMemberships o
      where o.tenantId = m.tenantId and o.workspaceId = m.workspaceId and o.role = 'owner'
    )
    order by m.workspaceId
  `.execute(db)
  if (ownerless.rows.length > 0) {
    const ids = ownerless.rows.map((row) => row.workspaceId).join(', ')
    throw new Error(
      `Cannot place workspaces with members but no owner in a namespace: ${ids}. ` +
        "Set one of each workspace's workspaceMemberships rows to role 'owner' and start again " +
        '(no server command can, since every one of them keeps an owner).',
    )
  }
  await sql`
    update workspaces set namespace = coalesce((
      select p.handle from workspaceMemberships o
      join memberProfiles p on p.id = o.profileId and p.tenantId = o.tenantId
      where o.tenantId = workspaces.tenantId and o.workspaceId = workspaces.id
        and o.role = 'owner'
      order by o.createdAt asc, o.profileId asc
      limit 1
    ), ${SINGLE_PERSON_NAMESPACE})
  `.execute(db)
}

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    const typed = db as Kysely<MigrationSchema>
    await db.schema.alterTable('memberProfiles').addColumn('handle', 'text').execute()
    await mintHandles(typed)
    await db.schema
      .createIndex('memberProfiles_handle_unique')
      .on('memberProfiles')
      .columns(['tenantId', 'handle'])
      .unique()
      .execute()

    await db.schema
      .alterTable('workspaces')
      .addColumn('namespace', 'text', (col) => col.notNull().defaultTo(SINGLE_PERSON_NAMESPACE))
      .execute()
    await placeWorkspaces(typed)
    await db.schema.dropIndex('workspaces_segment_unique').execute()
    await db.schema
      .createIndex('workspaces_namespace_segment_unique')
      .on('workspaces')
      .columns(['tenantId', 'namespace', 'segment'])
      .unique()
      .execute()
  },
  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('workspaces_namespace_segment_unique').execute()
    // Fails loudly when two namespaces now hold one segment, rather than
    // choosing which of them loses it.
    await db.schema
      .createIndex('workspaces_segment_unique')
      .on('workspaces')
      .column('segment')
      .unique()
      .execute()
    await db.schema.alterTable('workspaces').dropColumn('namespace').execute()
    await db.schema.dropIndex('memberProfiles_handle_unique').execute()
    await db.schema.alterTable('memberProfiles').dropColumn('handle').execute()
  },
}
