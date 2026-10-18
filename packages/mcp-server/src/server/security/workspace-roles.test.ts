/**
 * ADR-0049 decision 1 and its consequence: a workspace's owners manage its
 * members, and the product never leaves a workspace without an owner.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceRole } from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import { Kysely, type Selectable } from 'kysely'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { busyRetryingDialect } from '../store/db/busy-retry.js'
import { DB_FILENAME } from '../store/db/index.js'
import type { DatabaseSchema } from '../store/db/schema.js'
import { tenantDatabase } from '../store/db/tenant-database.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { upsertWorkspaceRow } from '../store/db/upsert-workspace.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'
import {
  createWorkspaceRoles,
  type WorkspaceMember,
  type WorkspaceRoles,
} from './workspace-roles.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let roles: WorkspaceRoles

const user = (subject: string) =>
  members.ensureProfile({ binding: { authenticator: 'oidc:test', subject }, displayName: subject })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-workspace-roles-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
  roles = createWorkspaceRoles(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('createWorkspaceRoles', () => {
  it('lists a workspace’s members with their roles', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await members.addMember('ws-1', ada.id)
    await members.addMember('ws-1', bob.id)
    await members.addMember('ws-2', bob.id)
    // Two memberships made in one millisecond have no defined order.
    const listed = (await roles.list('ws-1')).map((m) => [
      m.profile.displayName,
      m.role,
      m.deactivated,
    ])
    expect(listed.sort()).toEqual([
      ['ada', 'owner', false],
      ['bob', 'member', false],
    ])
  })

  it('makes a member an owner, and an owner a member while another owner remains', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await members.addMember('ws-1', ada.id)
    await members.addMember('ws-1', bob.id)
    expect(await roles.setRole('ws-1', bob.id, 'owner')).toBe('ok')
    expect(await roles.setRole('ws-1', ada.id, 'member')).toBe('ok')
    expect(await members.membershipRole('ws-1', ada.id)).toBe('member')
    expect(await members.membershipRole('ws-1', bob.id)).toBe('owner')
  })

  it('refuses to demote or remove the last owner', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await members.addMember('ws-1', ada.id)
    await members.addMember('ws-1', bob.id)
    expect(await roles.setRole('ws-1', ada.id, 'member')).toBe('last-owner')
    expect(await roles.remove('ws-1', ada.id)).toBe('last-owner')
    expect(await members.membershipRole('ws-1', ada.id)).toBe('owner')
  })

  // Another workspace's owners do not count towards this one's.
  it('counts only this workspace’s owners', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await members.addMember('ws-1', ada.id)
    await members.addMember('ws-2', bob.id)
    await members.addMember('ws-1', bob.id)
    expect(await roles.remove('ws-1', ada.id)).toBe('last-owner')
  })

  it('removes a member, and answers for one who is not there', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await members.addMember('ws-1', ada.id)
    await members.addMember('ws-1', bob.id)
    expect(await roles.remove('ws-1', bob.id)).toBe('ok')
    expect(await members.membershipRole('ws-1', bob.id)).toBeNull()
    expect(await roles.remove('ws-1', bob.id)).toBe('not-a-member')
    expect(await roles.setRole('ws-1', bob.id, 'owner')).toBe('not-a-member')
  })
})

// ADR-0053: a bare segment means the caller's own namespace, so a workspace
// that moves into somebody's namespace without them choosing its segment must
// not answer to a name they would type for one of their own.
describe('createWorkspaceRoles — a workspace handed to a new holder', () => {
  async function placed(id: string) {
    return handle.db
      .selectFrom('workspaces')
      .select(['namespace', 'segment'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  async function heldAt(namespace: string, segment: string) {
    const row = await handle.db
      .selectFrom('workspaces')
      .select('id')
      .where('namespace', '=', namespace)
      .where('segment', '=', segment)
      .executeTakeFirst()
    return row?.id ?? null
  }

  async function journalOf(holder: { id: string; handle: string }) {
    await upsertWorkspaceRow(handle.db, 'ws-journal', {
      namespace: holder.handle,
      segment: 'journal',
    })
    await members.addMember('ws-journal', holder.id)
  }

  it.each([
    ['demotes', (id: string, by: string) => roles.setRoleAsOwner('ws-journal', id, 'member', by)],
    ['removes', (id: string, by: string) => roles.removeAsOwner('ws-journal', id, by)],
  ] as const)("keeps a holder who %s themself from planting a segment in an owner's namespace", async (_, leave) => {
    const mallory = await user('mallory')
    const bob = await user('bob')
    await journalOf(mallory)
    expect(await roles.addAsOwner('ws-journal', bob.id, mallory.id)).toBe('ok')
    expect(await roles.setRoleAsOwner('ws-journal', bob.id, 'owner', mallory.id)).toBe('ok')

    expect(await leave(mallory.id, mallory.id)).toBe('ok')

    const moved = await placed('ws-journal')
    expect(moved.namespace).toBe(bob.handle)
    expect(moved.segment).not.toBeNull()
    expect(await heldAt(bob.handle, 'journal')).toBeNull()
  })

  it('keeps a planted segment out through a second account of the planter', async () => {
    const mallory = await user('mallory')
    const alt = await user('mallory-alt')
    const bob = await user('bob')
    await journalOf(mallory)
    for (const id of [alt.id, bob.id]) {
      expect(await roles.addAsOwner('ws-journal', id, mallory.id)).toBe('ok')
      expect(await roles.setRoleAsOwner('ws-journal', id, 'owner', mallory.id)).toBe('ok')
    }
    // The second account joined first, so it is the oldest remaining owner.
    await handle.db
      .updateTable('workspaceMemberships')
      .set({ createdAt: 1 })
      .where('workspaceId', '=', 'ws-journal')
      .where('profileId', '=', alt.id)
      .execute()

    expect(await roles.setRoleAsOwner('ws-journal', mallory.id, 'member', alt.id)).toBe('ok')
    const first = await placed('ws-journal')
    expect(first.namespace).toBe(alt.handle)
    expect(await roles.setRoleAsOwner('ws-journal', alt.id, 'member', bob.id)).toBe('ok')

    // A second hand-over finds the id's tail already there and adds no other.
    expect(await placed('ws-journal')).toEqual({ namespace: bob.handle, segment: first.segment })
    expect(await heldAt(bob.handle, 'journal')).toBeNull()
  })

  it('adds no second tail after a hand-over suffixed the first one', async () => {
    const mallory = await user('mallory')
    const alt = await user('mallory-alt')
    const bob = await user('bob')
    await journalOf(mallory)
    // The tailed segment the first hand-over wants is already taken there.
    await upsertWorkspaceRow(handle.db, 'ws-other', {
      namespace: alt.handle,
      segment: 'journal-sjournal',
    })
    for (const id of [alt.id, bob.id]) {
      expect(await roles.addAsOwner('ws-journal', id, mallory.id)).toBe('ok')
      expect(await roles.setRoleAsOwner('ws-journal', id, 'owner', mallory.id)).toBe('ok')
    }
    await handle.db
      .updateTable('workspaceMemberships')
      .set({ createdAt: 1 })
      .where('workspaceId', '=', 'ws-journal')
      .where('profileId', '=', alt.id)
      .execute()

    expect(await roles.setRoleAsOwner('ws-journal', mallory.id, 'member', alt.id)).toBe('ok')
    expect(await placed('ws-journal')).toEqual({
      namespace: alt.handle,
      segment: 'journal-sjournal-2',
    })
    expect(await roles.setRoleAsOwner('ws-journal', alt.id, 'member', bob.id)).toBe('ok')

    expect(await placed('ws-journal')).toEqual({
      namespace: bob.handle,
      segment: 'journal-sjournal-2',
    })
  })

  it('cuts a long segment for its tail without leaving a dash before it', async () => {
    const mallory = await user('mallory')
    const bob = await user('bob')
    // 200 chars at most, less the tail and its dash, ends this one on a dash.
    const long = `${'a'.repeat(190)}-bcd`
    await upsertWorkspaceRow(handle.db, 'ws-journal', { namespace: mallory.handle, segment: long })
    await members.addMember('ws-journal', mallory.id)
    expect(await roles.addAsOwner('ws-journal', bob.id, mallory.id)).toBe('ok')
    expect(await roles.setRoleAsOwner('ws-journal', bob.id, 'owner', mallory.id)).toBe('ok')

    expect(await roles.removeAsOwner('ws-journal', mallory.id, mallory.id)).toBe('ok')

    expect((await placed('ws-journal')).segment).toBe(`${'a'.repeat(190)}-sjournal`)
  })

  it("leaves the recipient's own segment of that name where it was", async () => {
    const mallory = await user('mallory')
    const bob = await user('bob')
    await journalOf(mallory)
    await upsertWorkspaceRow(handle.db, 'ws-bobs', { namespace: bob.handle, segment: 'journal' })
    expect(await roles.addAsOwner('ws-journal', bob.id, mallory.id)).toBe('ok')
    expect(await roles.setRoleAsOwner('ws-journal', bob.id, 'owner', mallory.id)).toBe('ok')

    expect(await roles.removeAsOwner('ws-journal', mallory.id, mallory.id)).toBe('ok')

    expect(await heldAt(bob.handle, 'journal')).toBe('ws-bobs')
    expect((await placed('ws-journal')).segment).not.toMatch(/^journal(-\d+)?$/)
  })
})

// The route authorizes an owner before the change runs, so the change itself
// re-checks, in the same transaction, that the actor still owns the workspace.
describe('createWorkspaceRoles — on an owner’s behalf', () => {
  async function demotedAda() {
    const [ada, bob, cy] = [await user('ada'), await user('bob'), await user('cy')]
    await members.addMember('ws-1', ada.id)
    await members.addMember('ws-1', bob.id)
    await members.addMember('ws-1', cy.id)
    expect(await roles.setRoleAsOwner('ws-1', bob.id, 'owner', ada.id)).toBe('ok')
    expect(await roles.setRoleAsOwner('ws-1', ada.id, 'member', bob.id)).toBe('ok')
    return { ada, bob, cy }
  }

  it('refuses a role change by an owner demoted since', async () => {
    const { ada, cy } = await demotedAda()
    expect(await roles.setRoleAsOwner('ws-1', cy.id, 'owner', ada.id)).toBe('not-an-owner')
    expect(await members.membershipRole('ws-1', cy.id)).toBe('member')
  })

  it('refuses a removal by an owner demoted since', async () => {
    const { ada, cy } = await demotedAda()
    expect(await roles.removeAsOwner('ws-1', cy.id, ada.id)).toBe('not-an-owner')
    expect(await members.membershipRole('ws-1', cy.id)).toBe('member')
  })

  it('refuses an admission by an owner demoted since, and admits for one who owns', async () => {
    const { ada, bob } = await demotedAda()
    const dee = await user('dee')
    expect(await roles.addAsOwner('ws-1', dee.id, ada.id)).toBe('not-an-owner')
    expect(await members.membershipRole('ws-1', dee.id)).toBeNull()
    expect(await roles.addAsOwner('ws-1', dee.id, bob.id)).toBe('ok')
    expect(await members.membershipRole('ws-1', dee.id)).toBe('member')
  })

  it('refuses an owner of another workspace', async () => {
    const { cy } = await demotedAda()
    const eve = await user('eve')
    await members.addMember('ws-2', eve.id)
    expect(await roles.setRoleAsOwner('ws-1', cy.id, 'owner', eve.id)).toBe('not-an-owner')
  })

  it('still names a missing member and the last owner for an owner who acts', async () => {
    const { bob, cy } = await demotedAda()
    expect(await roles.removeAsOwner('ws-1', 'nobody', bob.id)).toBe('not-a-member')
    expect(await roles.setRoleAsOwner('ws-1', bob.id, 'member', bob.id)).toBe('last-owner')
    expect(await roles.removeAsOwner('ws-1', cy.id, bob.id)).toBe('ok')
  })
})

// Two keepers sharing one database (a multi-instance deployment): two owners
// demoting each other at once. Exactly one wins; the other is refused by the
// last-owner rule rather than failing on the database's write lock.
describe('createWorkspaceRoles — two connections at once', () => {
  it('lets one demotion through and refuses the other as the last owner', async () => {
    const fileRoot = await mkdtemp(join(tmpdir(), 'wb-workspace-roles-race-'))
    const first = await createIsolatedDb({ dataDir: fileRoot, memory: false })
    // The production dialect on both sides: a role change is a transaction,
    // which waits out the other's write lock rather than failing on it.
    const second = tenantDatabase(
      new Kysely<DatabaseSchema>({
        dialect: busyRetryingDialect({ url: `file:${join(fileRoot, DB_FILENAME)}` }),
      }),
      SELF_HOST_TENANT_ID,
    )
    try {
      const people = createMemberProfileStore(first.db)
      for (let round = 0; round < 5; round++) {
        const ws = `ws-race-${round}`
        const ada = await people.ensureProfile({
          binding: { authenticator: 'oidc:test', subject: `ada-${round}` },
          displayName: 'ada',
        })
        const bob = await people.ensureProfile({
          binding: { authenticator: 'oidc:test', subject: `bob-${round}` },
          displayName: 'bob',
        })
        await people.addMember(ws, ada.id)
        await people.addMember(ws, bob.id)
        await createWorkspaceRoles(first.db).setRole(ws, bob.id, 'owner')
        const outcomes = await Promise.all([
          createWorkspaceRoles(first.db).setRole(ws, ada.id, 'member'),
          createWorkspaceRoles(second).setRole(ws, bob.id, 'member'),
        ])
        expect(outcomes.sort()).toEqual(['last-owner', 'ok'])
        const owners = (await createWorkspaceRoles(first.db).list(ws)).filter(
          (m) => m.role === 'owner',
        )
        expect(owners).toHaveLength(1)
      }
    } finally {
      await second.destroy()
      await first.dispose()
      await rm(fileRoot, { recursive: true, force: true })
    }
  })
})

// The people list answers through the contract's schema, so a role the server
// can hold that the contract lacks type-checks and fails only at runtime, as a
// 500. Every server spelling of the role is therefore the contract's type.
describe('the workspace role the server holds', () => {
  it('is the people contract’s role, in the store, the member store and the row', () => {
    expectTypeOf<WorkspaceMember['role']>().toEqualTypeOf<WorkspaceRole>()
    expectTypeOf<
      Awaited<ReturnType<MemberProfileStore['membershipRole']>>
    >().toEqualTypeOf<WorkspaceRole | null>()
    expectTypeOf<
      Selectable<DatabaseSchema['workspaceMemberships']>['role']
    >().toEqualTypeOf<WorkspaceRole>()
  })
})
