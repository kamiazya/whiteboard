/**
 * ADR-0051 decisions 1 to 4: deleting a person. Only a deactivated person can
 * be deleted, the sole owner of a workspace cannot be, and deleting removes
 * who they were — the user row, memberships, appointment, pending
 * invitations and sessions — so the keeper keeps nothing to recognise them
 * by. The account itself is keeper-wide and retired separately.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { upsertWorkspaceRow } from '../store/db/upsert-workspace.js'
import { createInvitationStore, type InvitationStore } from './invitation-store.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'
import { createSignInSessionStore, type SignInSessionStore } from './sign-in-session-store.js'
import { createTenantAdministratorStore } from './tenant-administrator-store.js'
import { createUserDeactivation } from './user-deactivation.js'
import { createUserDeletion } from './user-deletion.js'
import { createWorkspaceRoles } from './workspace-roles.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let sessions: SignInSessionStore
let invitations: InvitationStore
const retireAccount = vi.fn(async (_accountId: string) => {})

const ada = { authenticator: 'oidc:https://id.example', subject: 'ada' }
const bob = { authenticator: 'oidc:https://id.example', subject: 'bob' }
const HOUR = 3_600_000

async function deactivated(binding: typeof ada, displayName: string) {
  const user = await members.ensureProfile({ binding, displayName })
  await createUserDeactivation(handle.db).deactivate(user.id, 1_000)
  return user
}

const deletion = () => createUserDeletion(handle.db, retireAccount)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-user-deletion-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
  sessions = createSignInSessionStore(handle.db)
  invitations = createInvitationStore(handle.db)
  retireAccount.mockClear()
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('createUserDeletion', () => {
  it('refuses someone who is not deactivated, and leaves them as they were', async () => {
    const user = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    expect(await deletion().delete(user.id)).toEqual({ kind: 'not-deactivated' })
    expect((await members.profileForBinding(ada))?.id).toBe(user.id)
  })

  it('refuses a user id this tenant does not have', async () => {
    expect(await deletion().delete('nobody')).toEqual({ kind: 'unknown-user' })
  })

  it('refuses the sole owner of a workspace, naming it, and counts another owner however deactivated', async () => {
    const user = await deactivated(ada, 'Ada')
    const other = await members.ensureProfile({ binding: bob, displayName: 'Bob' })
    await members.addMember('ws-alone', user.id)
    await members.addMember('ws-shared', user.id)
    await members.addMember('ws-shared', other.id)
    await createWorkspaceRoles(handle.db).setRole('ws-shared', other.id, 'owner')
    await createUserDeactivation(handle.db).deactivate(other.id, 2_000)

    expect(await deletion().delete(user.id)).toEqual({
      kind: 'sole-owner',
      workspaceIds: ['ws-alone'],
    })
    expect(await members.membershipRole('ws-alone', user.id)).toBe('owner')
  })

  it('removes who they were, keeps everyone else, and hands the account on to be retired', async () => {
    const user = await deactivated(ada, 'Ada')
    const other = await members.ensureProfile({ binding: bob, displayName: 'Bob' })
    await members.addMember('ws-1', other.id)
    await members.addMember('ws-1', user.id)
    const admins = createTenantAdministratorStore(handle.db)
    await admins.appoint(user.id, null)
    await admins.appoint(other.id, user.id)
    const pending = await invitations.createLink({
      invitedBy: user.id,
      workspaceId: 'ws-1',
      now: 0,
      ttlMs: HOUR,
    })
    const bobs = await sessions.create(bob, 0, HOUR)

    expect(await deletion().delete(user.id)).toEqual({ kind: 'deleted' })

    expect((await members.listUsers()).map((u) => u.id)).toEqual([other.id])
    expect(await members.isWorkspaceMember('ws-1', user.id)).toBe('not-a-member')
    expect(await admins.isAppointed(user.id)).toBe(false)
    // The id another record keeps is left as it is: nothing resolves it.
    expect((await admins.list()).find((a) => a.profileId === other.id)?.appointedBy).toBe(user.id)
    expect(await invitations.openLink(pending.token, 0)).toMatchObject({ ok: false })
    expect(await sessions.resolve(bobs, 1)).toEqual(bob)
    expect(await members.isWorkspaceMember('ws-1', other.id)).toBe('member')
    const accountId = (
      await handle.db
        .selectFrom('accountBindings')
        .select('accountId')
        .where('subject', '=', 'ada')
        .executeTakeFirstOrThrow()
    ).accountId
    expect(retireAccount).toHaveBeenCalledWith(accountId)
  })

  it('keeps an invitation they issued that was already redeemed, and drops one still open', async () => {
    // Redeemed while its inviter could still invite, then they were deactivated.
    const user = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await members.addMember('ws-1', user.id)
    const redeemed = await invitations.createLink({
      invitedBy: user.id,
      workspaceId: 'ws-1',
      now: 0,
      ttlMs: HOUR,
    })
    const open = await invitations.createLink({
      invitedBy: user.id,
      workspaceId: 'ws-1',
      now: 0,
      ttlMs: HOUR,
    })
    expect(await invitations.redeem(redeemed.invitation.id, 'p-bob', 1)).toBe(true)
    await createUserDeactivation(handle.db).deactivate(user.id, 1)
    const other = await members.ensureProfile({ binding: bob, displayName: 'Bob' })
    await members.addMember('ws-1', other.id)
    await createWorkspaceRoles(handle.db).setRole('ws-1', other.id, 'owner')

    expect(await deletion().delete(user.id)).toEqual({ kind: 'deleted' })

    // A deleted row answers 'unknown'; a kept redeemed one still says it was redeemed.
    expect(await invitations.openLink(redeemed.token, 2)).toEqual({ ok: false, reason: 'redeemed' })
    expect(await invitations.openLink(open.token, 2)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('ends a session still held, so nothing is left to resume as them', async () => {
    const user = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await createUserDeactivation(handle.db).deactivate(user.id, 1_000)
    // A session opened after deactivation cannot happen through sign-in; it
    // stands for one that a racing request created.
    const late = await sessions.create(ada, 0, HOUR)
    await deletion().delete(user.id)
    expect(await sessions.resolve(late, 1)).toBeNull()
  })

  it('leaves a session for the same subject under a different authenticator', async () => {
    const user = await deactivated(ada, 'Ada')
    const namesake = { authenticator: 'oidc:https://other.example', subject: ada.subject }
    const namesakes = await sessions.create(namesake, 0, HOUR)
    await deletion().delete(user.id)
    expect(await sessions.resolve(namesakes, 1)).toEqual(namesake)
  })
})

// ADR-0053 decision 4: the workspaces a deleted person's namespace holds move
// to each one's oldest surviving owner, and a segment that collides there is
// suffixed in the inheritor's namespace.
describe('createUserDeletion — the namespace a deleted person held', () => {
  const carol = { authenticator: 'oidc:https://id.example', subject: 'carol' }

  async function workspaceRow(id: string, namespace: string, segment: string) {
    await upsertWorkspaceRow(handle.db, id, { namespace, segment })
  }

  async function placed(id: string) {
    return handle.db
      .selectFrom('workspaces')
      .select(['namespace', 'segment'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  }

  it('moves each workspace to its oldest surviving owner, ties by user id', async () => {
    const user = await deactivated(ada, 'Ada')
    const bobUser = await members.ensureProfile({ binding: bob, displayName: 'Bob' })
    const carolUser = await members.ensureProfile({ binding: carol, displayName: 'Carol' })
    await workspaceRow('ws-1', user.handle, 'design')
    const roles = createWorkspaceRoles(handle.db)
    for (const id of [user.id, carolUser.id, bobUser.id]) await members.addMember('ws-1', id)
    for (const id of [carolUser.id, bobUser.id]) await roles.setRole('ws-1', id, 'owner')
    await handle.db
      .updateTable('workspaceMemberships')
      .set({ createdAt: 50 })
      .where('workspaceId', '=', 'ws-1')
      .where('profileId', '!=', user.id)
      .execute()

    expect(await deletion().delete(user.id)).toEqual({ kind: 'deleted' })

    const [first] = [bobUser, carolUser].sort((a, b) => (a.id < b.id ? -1 : 1))
    expect(await placed('ws-1')).toEqual({ namespace: first?.handle, segment: 'design' })
  })

  it("suffixes a segment the inheritor's namespace already holds", async () => {
    const user = await deactivated(ada, 'Ada')
    const bobUser = await members.ensureProfile({ binding: bob, displayName: 'Bob' })
    await workspaceRow('ws-ada', user.handle, 'design')
    await workspaceRow('ws-bob', bobUser.handle, 'design')
    await members.addMember('ws-ada', user.id)
    await members.addMember('ws-ada', bobUser.id)
    await createWorkspaceRoles(handle.db).setRole('ws-ada', bobUser.id, 'owner')

    expect(await deletion().delete(user.id)).toEqual({ kind: 'deleted' })

    expect(await placed('ws-ada')).toEqual({ namespace: bobUser.handle, segment: 'design-2' })
    expect(await placed('ws-bob')).toEqual({ namespace: bobUser.handle, segment: 'design' })
  })

  it('moves a workspace with no owner left to the namespace nobody holds', async () => {
    const user = await deactivated(ada, 'Ada')
    await workspaceRow('ws-empty', user.handle, 'design')

    expect(await deletion().delete(user.id)).toEqual({ kind: 'deleted' })

    expect(await placed('ws-empty')).toEqual({ namespace: 'me', segment: 'design' })
  })
})
