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

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let store: MemberProfileStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-member-profiles-'))
  handle = await createIsolatedDb({ dataDir: root })
  store = createMemberProfileStore(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

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

describe('addMember / listMembers', () => {
  it('is idempotent and listMembers returns the profile with its credentials', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    await store.addMember('ws-1', profile.id)

    const members = await store.listMembers('ws-1')
    expect(members).toEqual([profile])
  })

  it('orders multiple members by (createdAt, id) regardless of addMember call order', async () => {
    // Pin distinct createdAt values: ensureProfile's `now` comes from
    // Date.now(), and two calls in the same millisecond would tie on
    // createdAt and fall through to an id order this test cannot predict.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const ada = await store.ensureProfile({
        binding: passkeyBinding('https://a.example', 'cred-1'),
        displayName: 'Ada',
      })
      vi.setSystemTime(2_000)
      const bea = await store.ensureProfile({
        binding: passkeyBinding('https://b.example', 'cred-2'),
        displayName: 'Bea',
      })

      // Insert in the OPPOSITE order from profile creation: with no ORDER BY,
      // sqlite would answer in this (reversed) insertion order, so this
      // catches a dropped/reversed `orderBy` where the tie-insensitive
      // Set-based property test cannot.
      await store.addMember('ws-1', bea.id)
      await store.addMember('ws-1', ada.id)

      const members = await store.listMembers('ws-1')
      expect(members.map((m) => m.id)).toEqual([ada.id, bea.id])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('revokeL1Membership', () => {
  it('deletes the membership and returns the credentials it affected', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)

    const first = await store.revokeL1Membership('ws-1', profile.id)
    expect(first).toEqual({
      removed: true,
      credentials: [{ origin: 'https://a.example', credentialId: 'cred-1' }],
    })

    const second = await store.revokeL1Membership('ws-1', profile.id)
    expect(second.removed).toBe(false)
    expect(second.credentials).toEqual([{ origin: 'https://a.example', credentialId: 'cred-1' }])
  })

  it('has no tombstone — a following addMember re-admits the profile', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    await store.revokeL1Membership('ws-1', profile.id)
    await store.addMember('ws-1', profile.id)

    expect(await store.listMembers('ws-1')).toEqual([profile])
  })

  it('returns removed:false and an empty credentials list for an unknown profile', async () => {
    expect(await store.revokeL1Membership('ws-1', 'unknown-profile')).toEqual({
      removed: false,
      credentials: [],
    })
  })
})

describe('reopenToOriginTrust', () => {
  it('is false for a workspace that was never members-only', async () => {
    // Nothing to clear is not an error: an operator asking twice, or asking
    // about the wrong workspace, learns which without a failure to handle.
    expect(await store.reopenToOriginTrust('ws-1')).toBe(false)
  })

  it('clears the gate a revoke deliberately leaves standing', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    await store.revokeL1Membership('ws-1', profile.id)
    expect(await store.membersOnly('ws-1')).toBe(true)

    // The whole point (ADR-0042 decision 3's escape): an operator who
    // removed the last member — possibly their own — can return the
    // workspace to origin trust.
    expect(await store.reopenToOriginTrust('ws-1')).toBe(true)
    expect(await store.membersOnly('ws-1')).toBe(false)
  })

  it('leaves the memberships themselves alone', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)

    await store.reopenToOriginTrust('ws-1')

    // Reopening widens who may read; it does not remove the people who
    // already could. Deleting memberships here would make one operation two
    // decisions, and the second one silent.
    expect(await store.isWorkspaceMember('ws-1', profile.id)).toBe('member')
    expect((await store.listMembers('ws-1')).map((m) => m.id)).toEqual([profile.id])
  })

  it('re-closes on the next addMember, rather than staying open', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    await store.reopenToOriginTrust('ws-1')

    // The marker is re-inserted by the ordinary membership path, so a
    // reopen is a one-shot rather than a mode a workspace stays in.
    await store.addMember('ws-1', profile.id)
    expect(await store.membersOnly('ws-1')).toBe(true)
  })

  it('does not reopen an unrelated workspace', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-a', profile.id)
    await store.addMember('ws-b', profile.id)

    await store.reopenToOriginTrust('ws-a')

    expect(await store.membersOnly('ws-a')).toBe(false)
    expect(await store.membersOnly('ws-b')).toBe(true)
  })
})

describe('membersOnly', () => {
  it('is false for a fresh store', async () => {
    expect(await store.membersOnly('ws-1')).toBe(false)
  })

  it('is true after addMember, and stays true after revoking the only member', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    expect(await store.membersOnly('ws-1')).toBe(true)

    await store.revokeL1Membership('ws-1', profile.id)
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

  it('is member after addMember and not-a-member after revokeL1Membership', async () => {
    const profile = await store.ensureProfile({
      binding: passkeyBinding('https://a.example', 'cred-1'),
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    expect(await store.isWorkspaceMember('ws-1', profile.id)).toBe('member')

    await store.revokeL1Membership('ws-1', profile.id)
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

  // Reopening clears the members-only marker but keeps the members, so the
  // marker cannot be what decides "first".
  it('does not make a later member an owner after the workspace was reopened', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await store.addMember('ws-1', ada.id)
    await store.reopenToOriginTrust('ws-1')
    await store.addMember('ws-1', bob.id)
    expect(await store.membershipRole('ws-1', bob.id)).toBe('member')
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
