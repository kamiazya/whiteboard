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

  it('ends a session still held, so nothing is left to resume as them', async () => {
    const user = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await createUserDeactivation(handle.db).deactivate(user.id, 1_000)
    // A session opened after deactivation cannot happen through sign-in; it
    // stands for one that a racing request created.
    const late = await sessions.create(ada, 0, HOUR)
    await deletion().delete(user.id)
    expect(await sessions.resolve(late, 1)).toBeNull()
  })
})
