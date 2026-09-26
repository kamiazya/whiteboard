import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'
import { createSignInSessionStore, type SignInSessionStore } from './sign-in-session-store.js'
import { createUserDeactivation, type UserDeactivation } from './user-deactivation.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let sessions: SignInSessionStore
let deactivation: UserDeactivation

const ada = { authenticator: 'oidc:https://id.example', subject: 'ada' }
const bob = { authenticator: 'oidc:https://id.example', subject: 'bob' }
const HOUR = 3_600_000

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-user-deactivation-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
  sessions = createSignInSessionStore(handle.db)
  deactivation = createUserDeactivation(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('createUserDeactivation', () => {
  it('makes a deactivated user nobody to every request, and reactivating restores them', async () => {
    const user = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    expect(await deactivation.deactivate(user.id, 1_000)).toBe(true)
    expect(await members.profileForBinding(ada)).toBeNull()
    expect(await members.isDeactivated(ada)).toBe(true)

    expect(await deactivation.reactivate(user.id)).toBe(true)
    expect((await members.profileForBinding(ada))?.id).toBe(user.id)
    expect(await members.isDeactivated(ada)).toBe(false)
  })

  it('ends the user’s sessions and leaves everyone else’s', async () => {
    const user = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await members.ensureProfile({ binding: bob, displayName: 'Bob' })
    const adas = await sessions.create(ada, 0, HOUR)
    const bobs = await sessions.create(bob, 0, HOUR)

    await deactivation.deactivate(user.id, 1_000)
    await deactivation.reactivate(user.id)

    // Reactivating does not bring an ended session back.
    expect(await sessions.resolve(adas, 1)).toBeNull()
    expect(await sessions.resolve(bobs, 1)).toEqual(bob)
  })

  it('keeps the user’s memberships, so reactivating restores their access too', async () => {
    const user = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    await members.addMember('ws-1', user.id)
    await deactivation.deactivate(user.id, 1_000)
    await deactivation.reactivate(user.id)
    expect(await members.membershipRole('ws-1', user.id)).toBe('owner')
  })

  it('answers false for an unknown user and for a change already made', async () => {
    expect(await deactivation.deactivate('no-such-user', 1_000)).toBe(false)
    const user = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    expect(await deactivation.reactivate(user.id)).toBe(false)
    expect(await deactivation.deactivate(user.id, 1_000)).toBe(true)
    expect(await deactivation.deactivate(user.id, 2_000)).toBe(false)
  })

  it('is not deactivated for a binding with no user', async () => {
    expect(await members.isDeactivated(ada)).toBe(false)
  })
})
