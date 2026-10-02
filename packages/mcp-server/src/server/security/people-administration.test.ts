import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createAdministratorCheck } from './administrator-check.js'
import type { ResolvedGrant } from './credential-resolver.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'
import {
  ADMINISTRATION_WINDOW_MS,
  type AdministrationAccess,
  createAdministrationAccess,
  createPeopleAdministration,
  deletePerson,
  type PeopleAdministration,
} from './people-administration.js'
import {
  createTenantAdministratorStore,
  type TenantAdministratorStore,
} from './tenant-administrator-store.js'
import { createUserDeactivation } from './user-deactivation.js'
import { createUserDeletion, type UserDeletion } from './user-deletion.js'

const AUTHENTICATOR = 'oidc:https://idp.test'
const NOW = 10_000_000

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let appointments: TenantAdministratorStore
let people: PeopleAdministration
let access: AdministrationAccess
let deletion: UserDeletion
const ids: Record<string, string> = {}

function binding(subject: string) {
  return { authenticator: AUTHENTICATOR, subject }
}

function signedIn(subject: string, authenticatedAt: number | null): ResolvedGrant {
  return { kind: 'signed-in', scopes: [], person: binding(subject), authenticatedAt }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-people-administration-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
  appointments = createTenantAdministratorStore(handle.db)
  for (const name of ['ada', 'bob', 'cy']) {
    ids[name] = (await members.ensureProfile({ binding: binding(name), displayName: name })).id
  }
  await appointments.appoint(ids.ada as string, null)
  deletion = createUserDeletion(handle.db, async () => true)
  people = createPeopleAdministration({
    members,
    appointments,
    deactivation: createUserDeactivation(handle.db),
  })
  access = createAdministrationAccess({
    members,
    // cy administers by configuration, not by appointment; dee is configured
    // but has never become a user here.
    check: createAdministratorCheck({
      admins: appointments,
      members,
      configured: [binding('cy'), binding('dee')],
    }),
  })
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('authorizing an administration action', () => {
  it('names the administrator who is acting', async () => {
    expect(await access.authorize(signedIn('ada', NOW), NOW)).toEqual({
      kind: 'authorized',
      userId: ids.ada,
    })
    expect(await access.authorize(signedIn('cy', NOW), NOW)).toEqual({
      kind: 'authorized',
      userId: ids.cy,
    })
  })

  it('refuses anyone who is not an administrator, and a request with no grant', async () => {
    const refused = { kind: 'refused', reason: 'not_an_administrator' }
    expect(await access.authorize(signedIn('bob', NOW), NOW)).toEqual(refused)
    expect(await access.authorize(undefined, NOW)).toEqual(refused)
  })

  // A name in the configuration administers by that name alone, but an action
  // needs a user to attribute it to, and this person has none here.
  it('refuses a configured administrator who is not yet a user', async () => {
    expect(await access.authorize(signedIn('dee', NOW), NOW)).toEqual({
      kind: 'refused',
      reason: 'not_an_administrator',
    })
  })

  it('refuses a bearer, which has no browser to send back to the provider', async () => {
    const bearer: ResolvedGrant = { kind: 'external-bearer', scopes: [], person: binding('ada') }
    expect(await access.authorize(bearer, NOW)).toEqual({
      kind: 'refused',
      reason: 'sign_in_required',
    })
  })

  it('asks for a sign-in at the provider no older than the window', async () => {
    const stale = { kind: 'refused', reason: 'reauthentication_required' }
    expect(
      await access.authorize(signedIn('ada', NOW - ADMINISTRATION_WINDOW_MS - 1), NOW),
    ).toEqual(stale)
    expect(await access.authorize(signedIn('ada', null), NOW)).toEqual(stale)
    expect(
      (await access.authorize(signedIn('ada', NOW - ADMINISTRATION_WINDOW_MS), NOW)).kind,
    ).toBe('authorized')
  })

  it('answers who administers without asking for a recent sign-in', async () => {
    expect(await access.administratorOf(signedIn('ada', null))).toBe(ids.ada)
    expect(await access.administratorOf(signedIn('bob', NOW))).toBeNull()
  })
})

describe('deactivating a person', () => {
  it('refuses an administrator deactivating themselves', async () => {
    expect(await people.deactivate(ids.ada as string, ids.ada as string, NOW)).toEqual({
      kind: 'refused',
      reason: 'cannot_deactivate_self',
    })
    expect(await members.isDeactivated(binding('ada'))).toBe(false)
  })

  it('refuses someone who is not a user here', async () => {
    expect(await people.deactivate('nobody', ids.ada as string, NOW)).toEqual({
      kind: 'refused',
      reason: 'unknown_user',
    })
  })

  it('deactivates another user, and reports a repeat as unchanged', async () => {
    expect(await people.deactivate(ids.bob as string, ids.ada as string, NOW)).toEqual({
      kind: 'done',
      changed: true,
    })
    expect(await members.isDeactivated(binding('bob'))).toBe(true)
    expect(await people.deactivate(ids.bob as string, ids.ada as string, NOW)).toEqual({
      kind: 'done',
      changed: false,
    })
  })

  // The operator is nobody's user, so there is no self to protect.
  it('lets the operator deactivate anyone', async () => {
    expect(await people.deactivate(ids.ada as string, null, NOW)).toEqual({
      kind: 'done',
      changed: true,
    })
  })

  it('reactivates a user, and refuses one this keeper does not have', async () => {
    await people.deactivate(ids.bob as string, null, NOW)
    expect(await people.reactivate(ids.bob as string)).toEqual({ kind: 'done', changed: true })
    expect(await people.reactivate('nobody')).toEqual({ kind: 'refused', reason: 'unknown_user' })
  })
})

describe('appointing and dismissing administrators', () => {
  it('appoints a user, recording who appointed them', async () => {
    expect(await people.appoint(ids.bob as string, ids.ada as string)).toEqual({ kind: 'done' })
    expect(await appointments.list()).toContainEqual(
      expect.objectContaining({ profileId: ids.bob, appointedBy: ids.ada }),
    )
  })

  it('records the operator’s appointment as nobody’s', async () => {
    await people.appoint(ids.bob as string, null)
    expect(await appointments.list()).toContainEqual(
      expect.objectContaining({ profileId: ids.bob, appointedBy: null }),
    )
  })

  it('refuses to appoint or dismiss someone who is not a user here', async () => {
    const refused = { kind: 'refused', reason: 'unknown_user' }
    expect(await people.appoint('nobody', ids.ada as string)).toEqual(refused)
    expect(await people.dismiss('nobody', ids.ada as string)).toEqual(refused)
  })

  // Dismissing oneself could leave nobody to manage people but the operator.
  it('refuses an administrator dismissing themselves', async () => {
    expect(await people.dismiss(ids.ada as string, ids.ada as string)).toEqual({
      kind: 'refused',
      reason: 'cannot_dismiss_self',
    })
    expect(await appointments.isAppointed(ids.ada as string)).toBe(true)
  })

  it('dismisses another administrator, and the operator may dismiss anyone', async () => {
    await people.appoint(ids.bob as string, null)
    expect(await people.dismiss(ids.bob as string, ids.ada as string)).toEqual({ kind: 'done' })
    expect(await people.dismiss(ids.ada as string, null)).toEqual({ kind: 'done' })
    expect(await appointments.list()).toEqual([])
  })
})

describe('deleting a person', () => {
  it('refuses a user who is still active, then deletes them once deactivated', async () => {
    expect(await deletePerson(deletion, ids.bob as string)).toEqual({
      kind: 'refused',
      reason: 'not_deactivated',
    })
    await people.deactivate(ids.bob as string, null, NOW)
    expect(await deletePerson(deletion, ids.bob as string)).toEqual({ kind: 'done' })
    expect((await members.listUsers()).map((u) => u.id)).not.toContain(ids.bob)
  })

  it('refuses someone who is not a user here', async () => {
    expect(await deletePerson(deletion, 'nobody')).toEqual({
      kind: 'refused',
      reason: 'unknown_user',
    })
  })

  it('names the workspaces a sole owner would leave without one', async () => {
    const soleOwner: UserDeletion = {
      delete: async () => ({ kind: 'sole-owner', workspaceIds: ['ws-a', 'ws-b'] }),
    }
    expect(await deletePerson(soleOwner, ids.bob as string)).toEqual({
      kind: 'refused',
      reason: 'sole_owner',
      workspaceIds: ['ws-a', 'ws-b'],
    })
  })
})

describe('listing people', () => {
  // A deactivated administrator cannot act, so is not listed as one.
  it('lists every user, with a deactivated administrator as not administering', async () => {
    await people.appoint(ids.bob as string, null)
    await people.deactivate(ids.bob as string, null, NOW)
    const listed = await access.listPeople()
    const byName = Object.fromEntries(listed.map((p) => [p.displayName, p]))
    expect(byName.ada).toMatchObject({ userId: ids.ada, administrator: true, deactivated: false })
    expect(byName.cy).toMatchObject({ administrator: true })
    expect(byName.bob).toMatchObject({ deactivated: true, administrator: false })
    expect(listed).toHaveLength(3)
  })
})
