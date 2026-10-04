import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tenantDatabase } from '../store/db/tenant-database.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import {
  createMemberProfileStore,
  type MemberProfileStore,
  passkeyBinding,
} from './member-profile-store.js'
import { createWorkspaceRoles, type WorkspaceRoles } from './workspace-roles.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let store: MemberProfileStore
let roles: WorkspaceRoles

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-member-profiles-'))
  handle = await createIsolatedDb({ dataDir: root })
  store = createMemberProfileStore(handle.db)
  roles = createWorkspaceRoles(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

// The workspace's last owner cannot leave through the roles store, so the cases
// that need an empty workspace delete the membership row itself.
async function dropMembership(workspaceId: string, profileId: string): Promise<void> {
  await handle.rawDb
    .deleteFrom('workspaceMemberships')
    .where('workspaceId', '=', workspaceId)
    .where('profileId', '=', profileId)
    .execute()
}

describe('profileForBinding', () => {
  it('is null for an unknown (origin, credentialId)', async () => {
    expect(await store.profileForBinding(passkeyBinding('https://a.example', 'cred-1'))).toBeNull()
  })

  it('returns the profile once ensureProfile has claimed the credential', async () => {
    const minted = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    const found = await store.profileForBinding(passkeyBinding('https://a.example', 'cred-1'))
    expect(found).toEqual(minted)
  })
})

describe('ensureProfile', () => {
  it('mints once and reuses on a second call for the same credential', async () => {
    const first = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    const second = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'someone else entirely',
    })
    expect(second.id).toBe(first.id)
    expect(second.displayName).toBe('Ada')
  })

  it('treats the same credentialId under two different origins as independent claims', async () => {
    const a = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    const b = await store.ensureProfile({
      binding: passkeyBinding('https://b.example', 'cred-1'),
      displayName: 'Bea',
    })
    expect(b.id).not.toBe(a.id)
  })
})

describe('addMember', () => {
  it('is idempotent: a second call leaves one membership', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    await store.addMember('ws-1', profile.id)

    expect((await roles.list('ws-1')).map((m) => m.profile.id)).toEqual([profile.id])
  })
})

describe('removing a member', () => {
  it('has no tombstone — a following addMember re-admits the profile', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    await dropMembership('ws-1', profile.id)
    await store.addMember('ws-1', profile.id)

    expect((await roles.list('ws-1')).map((m) => m.profile.id)).toEqual([profile.id])
  })

  it('leaves the profile itself and its credentials in place', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    await dropMembership('ws-1', profile.id)

    expect(await store.profileForBinding(passkeyBinding('https://a.example', 'cred-1'))).toEqual(
      profile,
    )
  })
})

describe('membersOnly', () => {
  it('is false for a fresh store', async () => {
    expect(await store.membersOnly('ws-1')).toBe(false)
  })

  it('is true after addMember, and stays true after removing the only member', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    expect(await store.membersOnly('ws-1')).toBe(true)

    await dropMembership('ws-1', profile.id)
    expect(await store.membersOnly('ws-1')).toBe(true)
  })

  it('does not mark an unrelated workspace', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-a', profile.id)
    expect(await store.membersOnly('ws-b')).toBe(false)
  })

  it('a repeated addMember does not change since', async () => {
    vi.useFakeTimers()
    try {
      const profile = await store.ensureProfile({
        binding: passkeyBinding('https://a.example', 'cred-1'),
        displayName: 'Ada',
      })
      vi.setSystemTime(1_000)
      await store.addMember('ws-1', profile.id)
      vi.setSystemTime(2_000)
      await store.addMember('ws-1', profile.id)
      const row = await handle.db
        .selectFrom('workspaceMembersOnly')
        .selectAll()
        .where('workspaceId', '=', 'ws-1')
        .executeTakeFirstOrThrow()
      expect(row.since).toBe(1_000)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('isWorkspaceMember', () => {
  it('is not-a-member for an unknown workspace/profile pair on an empty store', async () => {
    expect(await store.isWorkspaceMember('ws-1', 'unknown-profile')).toBe('not-a-member')
  })

  it('is member after addMember and not-a-member once removed', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    expect(await store.isWorkspaceMember('ws-1', profile.id)).toBe('member')

    await dropMembership('ws-1', profile.id)
    expect(await store.isWorkspaceMember('ws-1', profile.id)).toBe('not-a-member')
  })

  it('scopes membership per workspace: a member of A is not-a-member of B', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-a', profile.id)
    expect(await store.isWorkspaceMember('ws-b', profile.id)).toBe('not-a-member')
  })
})

// ADR-0045: an ACCOUNT is the keeper-wide login identity, a USER (this
// store's profile) is who that account is inside one tenant.
describe('accounts and users', () => {
  const claim = { origin: 'https://a.example', credentialId: 'cred-1' }

  function storeFor(tenantId: string): MemberProfileStore {
    return createMemberProfileStore(tenantDatabase(handle.rawDb, tenantId))
  }

  async function count(table: 'accounts' | 'accountBindings'): Promise<number> {
    const rows = await handle.rawDb.selectFrom(table).selectAll().execute()
    return rows.length
  }

  it('one credential in two tenants is one account and a separate user in each', async () => {
    const [home, other] = [storeFor(SELF_HOST_TENANT_ID), storeFor('tenant-two')]
    const inHome = await home.ensureProfile({
      binding: passkeyBinding(claim.origin, claim.credentialId),
      displayName: 'Ada at home',
    })
    const inOther = await other.ensureProfile({
      binding: passkeyBinding(claim.origin, claim.credentialId),
      displayName: 'Ada at work',
    })

    expect(inOther.id).not.toBe(inHome.id)
    expect(
      (await home.profileForBinding(passkeyBinding(claim.origin, claim.credentialId)))?.displayName,
    ).toBe('Ada at home')
    expect(
      (await other.profileForBinding(passkeyBinding(claim.origin, claim.credentialId)))
        ?.displayName,
    ).toBe('Ada at work')
    expect(await count('accounts')).toBe(1)
    expect(await count('accountBindings')).toBe(1)
  })

  it('an account with no user in a tenant is nobody there', async () => {
    await storeFor(SELF_HOST_TENANT_ID).ensureProfile({
      binding: passkeyBinding(claim.origin, claim.credentialId),
      displayName: 'Ada',
    })
    expect(
      await storeFor('tenant-two').profileForBinding(
        passkeyBinding(claim.origin, claim.credentialId),
      ),
    ).toBeNull()
  })
})

// ADR-0049 decision 1: a workspace's first member is its owner, so whoever
// creates a workspace — or the operator granting its first member — can
// manage it; everyone admitted after is a member.
describe('membershipRole', () => {
  const user = (name: string) =>
    store.ensureProfile({ binding: passkeyBinding('https://a.example', name), displayName: name })

  it('makes the first member of a workspace its owner, and later ones members', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await store.addMember('ws-1', ada.id)
    await store.addMember('ws-1', bob.id)
    expect(await store.membershipRole('ws-1', ada.id)).toBe('owner')
    expect(await store.membershipRole('ws-1', bob.id)).toBe('member')
  })

  it('decides "first" per workspace, not across the tenant', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await store.addMember('ws-1', ada.id)
    await store.addMember('ws-2', bob.id)
    expect(await store.membershipRole('ws-2', bob.id)).toBe('owner')
  })

  it('is null for someone who is not a member', async () => {
    const ada = await user('ada')
    expect(await store.membershipRole('ws-1', ada.id)).toBeNull()
  })

  // "First" is read from the memberships, so the owner leaving and the
  // workspace emptying makes the next person the owner of a fresh start.
  it('makes the next member an owner once the workspace has emptied', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await store.addMember('ws-1', ada.id)
    await dropMembership('ws-1', ada.id)
    await store.addMember('ws-1', bob.id)
    expect(await store.membershipRole('ws-1', bob.id)).toBe('owner')
  })

  it('keeps an owner an owner when they are added again', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await store.addMember('ws-1', ada.id)
    await store.addMember('ws-1', bob.id)
    await store.addMember('ws-1', ada.id)
    expect(await store.membershipRole('ws-1', ada.id)).toBe('owner')
  })
})
