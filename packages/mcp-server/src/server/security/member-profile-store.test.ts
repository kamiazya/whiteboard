import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CapturedLogsHandle, captureLogsForTests } from '../log.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import {
  CredentialClaimedError,
  createMemberProfileStore,
  type MemberProfileStore,
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

describe('profileForCredential', () => {
  it('is null for an unknown (origin, credentialId)', async () => {
    expect(await store.profileForCredential('https://a.example', 'cred-1')).toBeNull()
  })

  it('returns the profile once ensureProfile has claimed the credential', async () => {
    const minted = await store.ensureProfile({
      origin: 'https://a.example',
      credentialId: 'cred-1',
      displayName: 'Ada',
    })
    const found = await store.profileForCredential('https://a.example', 'cred-1')
    expect(found).toEqual(minted)
  })
})

describe('ensureProfile', () => {
  it('mints once and reuses on a second call for the same credential', async () => {
    const first = await store.ensureProfile({
      origin: 'https://a.example',
      credentialId: 'cred-1',
      displayName: 'Ada',
    })
    const second = await store.ensureProfile({
      origin: 'https://a.example',
      credentialId: 'cred-1',
      displayName: 'someone else entirely',
    })
    expect(second.id).toBe(first.id)
    expect(second.displayName).toBe('Ada')
  })

  it('re-registration: an explicit profileId that matches the existing owner succeeds (no conflict)', async () => {
    const owner = await store.ensureProfile({
      origin: 'https://a.example',
      credentialId: 'cred-1',
      displayName: 'Ada',
    })
    const reregistered = await store.ensureProfile({
      origin: 'https://a.example',
      credentialId: 'cred-1',
      displayName: 'Ada',
      profileId: owner.id,
    })
    expect(reregistered).toEqual(owner)
  })

  it('treats the same credentialId under two different origins as independent claims', async () => {
    const a = await store.ensureProfile({
      origin: 'https://a.example',
      credentialId: 'cred-1',
      displayName: 'Ada',
    })
    const b = await store.ensureProfile({
      origin: 'https://b.example',
      credentialId: 'cred-1',
      displayName: 'Bea',
    })
    expect(b.id).not.toBe(a.id)
  })

  it('refuses a credential already claimed by a different profile, and logs the refusal', async () => {
    const owner = await store.ensureProfile({
      origin: 'https://a.example',
      credentialId: 'cred-1',
      displayName: 'Ada',
    })
    const other = await store.ensureProfile({
      origin: 'https://a.example',
      credentialId: 'cred-2',
      displayName: 'Bea',
    })

    const cap: CapturedLogsHandle = captureLogsForTests('debug')
    try {
      await expect(
        store.ensureProfile({
          origin: 'https://a.example',
          credentialId: 'cred-1',
          displayName: 'Ada',
          profileId: other.id,
        }),
      ).rejects.toBeInstanceOf(CredentialClaimedError)

      const record = cap.records.find((r) => r.scope === 'member-profiles')
      expect(record?.level).toBe('warning')
      expect(record?.data).toMatchObject({
        origin: 'https://a.example',
        credentialId: 'cred-1',
        ownerProfileId: owner.id,
        requestedProfileId: other.id,
      })
    } finally {
      cap.restore()
    }

    // never merged: cred-1 still belongs to `owner` alone.
    expect(await store.profileForCredential('https://a.example', 'cred-1')).toEqual(owner)
  })
})

describe('addMember / listMembers', () => {
  it('is idempotent and listMembers returns the profile with its credentials', async () => {
    const profile = await store.ensureProfile({
      origin: 'https://a.example',
      credentialId: 'cred-1',
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
        origin: 'https://a.example',
        credentialId: 'cred-1',
        displayName: 'Ada',
      })
      vi.setSystemTime(2_000)
      const bea = await store.ensureProfile({
        origin: 'https://b.example',
        credentialId: 'cred-2',
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
      origin: 'https://a.example',
      credentialId: 'cred-1',
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
      origin: 'https://a.example',
      credentialId: 'cred-1',
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

describe('isWorkspaceMember', () => {
  it('is not-a-member for an unknown workspace/profile pair on an empty store', async () => {
    expect(await store.isWorkspaceMember('ws-1', 'unknown-profile')).toBe('not-a-member')
  })

  it('is member after addMember and not-a-member after revokeL1Membership', async () => {
    const profile = await store.ensureProfile({
      origin: 'https://a.example',
      credentialId: 'cred-1',
      displayName: 'Ada',
    })
    await store.addMember('ws-1', profile.id)
    expect(await store.isWorkspaceMember('ws-1', profile.id)).toBe('member')

    await store.revokeL1Membership('ws-1', profile.id)
    expect(await store.isWorkspaceMember('ws-1', profile.id)).toBe('not-a-member')
  })

  it('scopes membership per workspace: a member of A is not-a-member of B', async () => {
    const profile = await store.ensureProfile({
      origin: 'https://a.example',
      credentialId: 'cred-1',
      displayName: 'Ada',
    })
    await store.addMember('ws-a', profile.id)
    expect(await store.isWorkspaceMember('ws-b', profile.id)).toBe('not-a-member')
  })
})
