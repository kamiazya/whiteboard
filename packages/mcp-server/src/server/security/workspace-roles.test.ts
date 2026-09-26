/**
 * ADR-0049 decision 1 and its consequence: a workspace's owners manage its
 * members, and the product never leaves a workspace without an owner.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'
import { createWorkspaceRoles, type WorkspaceRoles } from './workspace-roles.js'

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
  it('lists a workspace’s members with their roles, oldest first', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await members.addMember('ws-1', ada.id)
    await members.addMember('ws-1', bob.id)
    await members.addMember('ws-2', bob.id)
    expect(
      (await roles.list('ws-1')).map((m) => [m.profile.displayName, m.role, m.deactivated]),
    ).toEqual([
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
