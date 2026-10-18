/**
 * ADR-0046 decision 6: an invitation reaches a person as a one-time,
 * expiring link. It creates a USER for an account and nothing else.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tenantDatabase } from '../store/db/tenant-database.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createInvitationStore, type InvitationStore } from './invitation-store.js'
import { isInvitationTokenShaped } from './invitation-token.js'
import { createMemberProfileStore } from './member-profile-store.js'
import { createTenantAdministratorStore } from './tenant-administrator-store.js'
import { createWorkspaceRoles } from './workspace-roles.js'

const HOUR = 60 * 60 * 1000
const T0 = 1_800_000_000_000

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let store: InvitationStore
/** An administrator, and the owner of `ws-1`: someone whose links stay good. */
let ada: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-invitations-'))
  handle = await createIsolatedDb({ dataDir: root })
  store = createInvitationStore(handle.db)
  const members = createMemberProfileStore(handle.db)
  const user = await members.ensureProfile({
    binding: { authenticator: 'oidc:https://idp.test', subject: 'ada' },
    displayName: 'Ada',
  })
  await members.addMember('ws-1', user.id)
  await createTenantAdministratorStore(handle.db).appoint(user.id, null)
  ada = user.id
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('invitation links', () => {
  // The sign-in route refuses anything else before storing it, so a minted
  // token outside the shape would be a link nobody can use.
  it('mints only tokens of the shape the sign-in route accepts', async () => {
    for (let i = 0; i < 20; i++) {
      const { token } = await store.createLink({ invitedBy: ada, now: T0, ttlMs: HOUR })
      expect(isInvitationTokenShaped(token), token).toBe(true)
    }
    expect(isInvitationTokenShaped(`${'A'.repeat(43)}x`)).toBe(false)
  })

  // ADR-0049 decision 3: a link may invite into a workspace; one that names
  // none invites to the tenant alone.
  it('carries the workspace it invites into, or none', async () => {
    const into = await store.createLink({
      invitedBy: ada,
      workspaceId: 'ws-1',
      now: T0,
      ttlMs: HOUR,
    })
    const bare = await store.createLink({ invitedBy: ada, now: T0, ttlMs: HOUR })
    expect(into.invitation.workspaceId).toBe('ws-1')
    expect(await store.openLink(into.token, T0 + 1)).toMatchObject({
      ok: true,
      invitation: { workspaceId: 'ws-1' },
    })
    expect(await store.openLink(bare.token, T0 + 1)).toMatchObject({
      ok: true,
      invitation: { workspaceId: null },
    })
  })

  it('hands the token back once and stores only its hash', async () => {
    const { token } = await store.createLink({ invitedBy: ada, now: T0, ttlMs: HOUR })
    const rows = await handle.rawDb.selectFrom('invitations').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  it('opens an unexpired link, and redeems it exactly once', async () => {
    const { token } = await store.createLink({ invitedBy: ada, now: T0, ttlMs: HOUR })
    const opened = await store.openLink(token, T0 + 1)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(await store.redeem(opened.invitation.id, 'p-bob', T0 + 2)).toBe(true)
    expect(await store.redeem(opened.invitation.id, 'p-eve', T0 + 3)).toBe(false)
    expect(await store.openLink(token, T0 + 4)).toEqual({ ok: false, reason: 'redeemed' })
  })

  it('refuses an expired link, whether opening or redeeming it', async () => {
    const { token, invitation } = await store.createLink({
      invitedBy: ada,
      now: T0,
      ttlMs: HOUR,
    })
    expect(await store.openLink(token, T0 + HOUR)).toEqual({ ok: false, reason: 'expired' })
    expect(await store.redeem(invitation.id, 'p-bob', T0 + HOUR)).toBe(false)
  })

  // A redeemed link records who let that person in, so it is no longer
  // pending and revoking it takes nothing back.
  it('neither lists nor revokes a link already redeemed', async () => {
    const link = { invitedBy: ada, workspaceId: 'ws-1', now: T0, ttlMs: HOUR }
    const spent = await store.createLink(link)
    const open = await store.createLink(link)
    expect(await store.redeem(spent.invitation.id, 'p-bob', T0 + 1)).toBe(true)
    expect((await store.listPending('ws-1', T0 + 2)).map((i) => i.id)).toEqual([open.invitation.id])
    expect(await store.revoke('ws-1', spent.invitation.id, ada)).toBe('unknown')
    expect(await store.openLink(spent.token, T0 + 2)).toEqual({ ok: false, reason: 'redeemed' })
    expect(await store.listPending('ws-1', T0 + HOUR)).toEqual([])
  })

  it('revokes for an owner, and refuses one demoted since they were authorized', async () => {
    const members = createMemberProfileStore(handle.db)
    const bob = await members.ensureProfile({
      binding: { authenticator: 'oidc:https://idp.test', subject: 'bob' },
      displayName: 'Bob',
    })
    await members.addMember('ws-1', bob.id)
    const roles = createWorkspaceRoles(handle.db)
    expect(await roles.setRole('ws-1', bob.id, 'owner')).toBe('ok')
    const link = { invitedBy: ada, workspaceId: 'ws-1', now: T0, ttlMs: HOUR }
    const first = await store.createLink(link)
    const second = await store.createLink(link)
    expect(await store.revoke('ws-1', first.invitation.id, bob.id)).toBe('revoked')
    expect(await roles.setRole('ws-1', bob.id, 'member')).toBe('ok')
    expect(await store.revoke('ws-1', second.invitation.id, bob.id)).toBe('not-an-owner')
    expect(await store.openLink(second.token, T0 + 1)).toMatchObject({ ok: true })
  })

  it('refuses a token it never issued', async () => {
    expect(await store.openLink('not-a-token', T0)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('is invisible to another tenant — a link from one tenant opens nothing in another', async () => {
    const { token } = await store.createLink({ invitedBy: ada, now: T0, ttlMs: HOUR })
    const other = createInvitationStore(tenantDatabase(handle.rawDb, 'tenant-two'))
    expect(await other.openLink(token, T0 + 1)).toEqual({ ok: false, reason: 'unknown' })
  })
})
