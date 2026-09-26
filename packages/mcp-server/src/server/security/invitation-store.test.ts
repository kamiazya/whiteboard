/**
 * ADR-0046 decision 6: an invitation reaches a person as a one-time,
 * expiring link (the default), or as an address a provider must assert
 * verified. It creates a USER for an account and nothing else.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tenantDatabase } from '../store/db/tenant-database.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createInvitationStore, type InvitationStore } from './invitation-store.js'

const HOUR = 60 * 60 * 1000
const T0 = 1_800_000_000_000

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let store: InvitationStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-invitations-'))
  handle = await createIsolatedDb({ dataDir: root })
  store = createInvitationStore(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('invitation links', () => {
  // ADR-0049 decision 3: a link may invite into a workspace; one that names
  // none invites to the tenant alone.
  it('carries the workspace it invites into, or none', async () => {
    const into = await store.createLink({
      invitedBy: 'p-ada',
      workspaceId: 'ws-1',
      now: T0,
      ttlMs: HOUR,
    })
    const bare = await store.createLink({ invitedBy: 'p-ada', now: T0, ttlMs: HOUR })
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
    const { token } = await store.createLink({ invitedBy: 'p-ada', now: T0, ttlMs: HOUR })
    const rows = await handle.rawDb.selectFrom('invitations').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  it('opens an unexpired link, and redeems it exactly once', async () => {
    const { token } = await store.createLink({ invitedBy: 'p-ada', now: T0, ttlMs: HOUR })
    const opened = await store.openLink(token, T0 + 1)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(await store.redeem(opened.invitation.id, 'p-bob', T0 + 2)).toBe(true)
    expect(await store.redeem(opened.invitation.id, 'p-eve', T0 + 3)).toBe(false)
    expect(await store.openLink(token, T0 + 4)).toEqual({ ok: false, reason: 'redeemed' })
  })

  it('refuses an expired link, whether opening or redeeming it', async () => {
    const { token, invitation } = await store.createLink({
      invitedBy: 'p-ada',
      now: T0,
      ttlMs: HOUR,
    })
    expect(await store.openLink(token, T0 + HOUR)).toEqual({ ok: false, reason: 'expired' })
    expect(await store.redeem(invitation.id, 'p-bob', T0 + HOUR)).toBe(false)
  })

  it('refuses a token it never issued', async () => {
    expect(await store.openLink('not-a-token', T0)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses a revoked link', async () => {
    const { token, invitation } = await store.createLink({
      invitedBy: 'p-ada',
      now: T0,
      ttlMs: HOUR,
    })
    expect(await store.revoke(invitation.id)).toBe(true)
    expect(await store.openLink(token, T0 + 1)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('is invisible to another tenant — a link from one tenant opens nothing in another', async () => {
    const { token } = await store.createLink({ invitedBy: 'p-ada', now: T0, ttlMs: HOUR })
    const other = createInvitationStore(tenantDatabase(handle.rawDb, 'tenant-two'))
    expect(await other.openLink(token, T0 + 1)).toEqual({ ok: false, reason: 'unknown' })
  })
})

describe('email invitations', () => {
  it('finds an open invitation by address, case-insensitively', async () => {
    await store.createForEmail({
      email: 'Ada@Corp.Example',
      invitedBy: 'p-bob',
      now: T0,
      ttlMs: HOUR,
    })
    const found = await store.openForEmail('ada@corp.example', T0 + 1)
    expect(found?.email).toBe('ada@corp.example')
    expect(await store.openForEmail('eve@corp.example', T0 + 1)).toBeNull()
  })

  it('does not find an expired or redeemed one', async () => {
    const invitation = await store.createForEmail({
      email: 'ada@corp.example',
      invitedBy: 'p-bob',
      now: T0,
      ttlMs: HOUR,
    })
    expect(await store.openForEmail('ada@corp.example', T0 + HOUR)).toBeNull()
    expect(await store.redeem(invitation.id, 'p-ada', T0 + 1)).toBe(true)
    expect(await store.openForEmail('ada@corp.example', T0 + 2)).toBeNull()
  })

  it('refuses an address that is not one', async () => {
    await expect(
      store.createForEmail({ email: 'not an address', invitedBy: 'p-bob', now: T0, ttlMs: HOUR }),
    ).rejects.toThrow()
  })
})
