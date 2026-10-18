import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'
import { createSignInSessionStore, type SignInSessionStore } from './sign-in-session-store.js'
import { createTenantAdministratorStore } from './tenant-administrator-store.js'
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

  it('leaves a session for the same subject under a different authenticator', async () => {
    const user = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    const namesake = { authenticator: 'oidc:https://other.example', subject: ada.subject }
    const adas = await sessions.create(ada, 0, HOUR)
    const namesakes = await sessions.create(namesake, 0, HOUR)

    await deactivation.deactivate(user.id, 1_000)

    expect(await sessions.resolve(adas, 1)).toBeNull()
    expect(await sessions.resolve(namesakes, 1)).toEqual(namesake)
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

// A tenant keeps at least one active administrator, as a workspace keeps an
// owner: the guard rides in the deactivating UPDATE, so two administrators
// deactivating each other at once cannot both succeed.
describe('deactivating while keeping an administrator', () => {
  const cy = { authenticator: 'oidc:https://id.example', subject: 'cy' }
  async function appointed(binding: typeof ada, name: string) {
    const user = await members.ensureProfile({ binding, displayName: name })
    await createTenantAdministratorStore(handle.db).appoint(user.id, null)
    return user.id
  }

  it('deactivates one of two administrators, and refuses the last one left', async () => {
    const adaId = await appointed(ada, 'Ada')
    const bobId = await appointed(bob, 'Bob')
    expect(await deactivation.deactivateKeepingAnAdministrator(bobId, 1_000, adaId)).toBe(
      'deactivated',
    )
    expect(await deactivation.deactivateKeepingAnAdministrator(adaId, 1_000, bobId)).toBe(
      'last-administrator',
    )
    expect(await members.isDeactivated(ada)).toBe(false)
    expect(await deactivation.deactivateKeepingAnAdministrator(bobId, 2_000, adaId)).toBe(
      'unchanged',
    )
  })

  it('lets exactly one of two administrators deactivating each other at once succeed', async () => {
    const adaId = await appointed(ada, 'Ada')
    const bobId = await appointed(bob, 'Bob')
    const outcomes = await Promise.all([
      deactivation.deactivateKeepingAnAdministrator(adaId, 1_000, bobId),
      deactivation.deactivateKeepingAnAdministrator(bobId, 1_000, adaId),
    ])
    expect([...outcomes].sort()).toEqual(['deactivated', 'last-administrator'])
  })

  it('deactivates someone who administers nothing, administrators or not', async () => {
    const user = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    const bobId = await appointed(bob, 'Bob')
    expect(await deactivation.deactivateKeepingAnAdministrator(user.id, 1_000, bobId)).toBe(
      'deactivated',
    )
  })

  it('refuses an actor who no longer administers, and changes nothing', async () => {
    const adaId = await appointed(ada, 'Ada')
    const bobId = await appointed(bob, 'Bob')
    const cyId = await appointed(cy, 'Cy')
    await createTenantAdministratorStore(handle.db).dismiss(adaId)
    expect(await deactivation.deactivateKeepingAnAdministrator(bobId, 1_000, adaId)).toBe(
      'not-an-administrator',
    )
    expect(await members.isDeactivated(bob)).toBe(false)
    await createTenantAdministratorStore(handle.db).appoint(adaId, null)
    await deactivation.deactivate(cyId, 1_000)
    expect(await deactivation.deactivateKeepingAnAdministrator(bobId, 1_000, cyId)).toBe(
      'not-an-administrator',
    )
  })

  it('counts an administrator the configuration names, and holds one to the rule too', async () => {
    const guarded = createUserDeactivation(handle.db, { configuredAdministrators: [cy] })
    const adaId = await appointed(ada, 'Ada')
    const cyId = (await members.ensureProfile({ binding: cy, displayName: 'Cy' })).id
    expect(await guarded.deactivateKeepingAnAdministrator(adaId, 1_000, cyId)).toBe('deactivated')
    expect(await guarded.deactivateKeepingAnAdministrator(cyId, 1_000, adaId)).toBe(
      'last-administrator',
    )
  })
})
