/**
 * ADR-0049 decision 2: a tenant's administrators, as appointed. The operator
 * appoints the first one; administrators appoint the rest. Administrators
 * named in configuration are not stored here (see administrator-check).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tenantDatabase } from '../store/db/tenant-database.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createMemberProfileStore, passkeyBinding } from './member-profile-store.js'
import {
  createTenantAdministratorStore,
  type TenantAdministratorStore,
} from './tenant-administrator-store.js'
import { createUserDeactivation } from './user-deactivation.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let admins: TenantAdministratorStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-tenant-admins-'))
  handle = await createIsolatedDb({ dataDir: root })
  admins = createTenantAdministratorStore(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

const user = (name: string) =>
  createMemberProfileStore(handle.db).ensureProfile({
    binding: passkeyBinding('https://a.example', name),
    displayName: name,
  })

describe('createTenantAdministratorStore', () => {
  it('knows nobody until someone is appointed', async () => {
    const ada = await user('ada')
    expect(await admins.isAppointed(ada.id)).toBe(false)
    expect(await admins.list()).toEqual([])
  })

  it('appoints, and records who appointed', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await admins.appoint(ada.id, null)
    await admins.appoint(bob.id, ada.id)
    expect(await admins.isAppointed(bob.id)).toBe(true)
    // Two appointments can share a millisecond, so the order between them is
    // not asserted here, only who appointed whom.
    const byUser = new Map((await admins.list()).map((a) => [a.profileId, a.appointedBy]))
    expect(byUser).toEqual(
      new Map<string, string | null>([
        [ada.id, null],
        [bob.id, ada.id],
      ]),
    )
  })

  it('is idempotent, keeping the first appointment', async () => {
    const ada = await user('ada')
    const bob = await user('bob')
    await admins.appoint(ada.id, null)
    await admins.appoint(bob.id, null)
    expect(await admins.appoint(bob.id, ada.id)).toBe('appointed')
    const bobs = (await admins.list()).filter((a) => a.profileId === bob.id)
    expect(bobs).toHaveLength(1)
    expect(bobs[0]?.appointedBy).toBeNull()
  })

  describe('appointing on an administrator’s behalf', () => {
    it('refuses an actor dismissed after their request was authorized', async () => {
      const [ada, bob, cy] = [await user('ada'), await user('bob'), await user('cy')]
      await admins.appoint(ada.id, null)
      await admins.appoint(bob.id, null)
      expect(await admins.dismissKeepingAnAdministrator(ada.id, bob.id)).toBe('dismissed')
      expect(await admins.appoint(cy.id, ada.id)).toBe('not-an-administrator')
      expect(await admins.isAppointed(cy.id)).toBe(false)
    })

    it('refuses an actor deactivated after their request was authorized', async () => {
      const [ada, bob, cy] = [await user('ada'), await user('bob'), await user('cy')]
      await admins.appoint(ada.id, null)
      await admins.appoint(bob.id, null)
      await createUserDeactivation(handle.db).deactivate(ada.id, 1_000)
      expect(await admins.appoint(cy.id, ada.id)).toBe('not-an-administrator')
      expect(await admins.isAppointed(cy.id)).toBe(false)
    })

    it('counts an actor the configuration names as administering', async () => {
      const configured = createTenantAdministratorStore(handle.db, {
        configuredAdministrators: [passkeyBinding('https://a.example', 'cy')],
      })
      const [bob, cy] = [await user('bob'), await user('cy')]
      expect(await configured.appoint(bob.id, cy.id)).toBe('appointed')
      expect(await admins.isAppointed(bob.id)).toBe(true)
    })
  })

  it('dismisses, and answers whether there was anyone to dismiss', async () => {
    const ada = await user('ada')
    await admins.appoint(ada.id, null)
    expect(await admins.dismiss(ada.id)).toBe(true)
    expect(await admins.dismiss(ada.id)).toBe(false)
    expect(await admins.isAppointed(ada.id)).toBe(false)
  })

  describe('dismissing on an administrator’s behalf', () => {
    it('dismisses while the actor administers, so never the last', async () => {
      const ada = await user('ada')
      const bob = await user('bob')
      await admins.appoint(ada.id, null)
      await admins.appoint(bob.id, null)
      expect(await admins.dismissKeepingAnAdministrator(bob.id, ada.id)).toBe('dismissed')
      await admins.appoint(bob.id, null)
      expect(await admins.dismissKeepingAnAdministrator(ada.id, bob.id)).toBe('dismissed')
      // bob alone is left; ada no longer administers, so cannot act at all.
      expect(await admins.dismissKeepingAnAdministrator(bob.id, ada.id)).toBe(
        'not-an-administrator',
      )
      expect(await admins.dismissKeepingAnAdministrator(bob.id, bob.id)).toBe(
        'not-an-administrator',
      )
      expect(await admins.isAppointed(bob.id)).toBe(true)
      expect(await admins.dismissKeepingAnAdministrator(ada.id, bob.id)).toBe('unchanged')
    })

    it('refuses an actor who no longer administers', async () => {
      const [ada, bob, cy] = [await user('ada'), await user('bob'), await user('cy')]
      for (const u of [ada, bob, cy]) await admins.appoint(u.id, null)
      await admins.dismiss(ada.id)
      expect(await admins.dismissKeepingAnAdministrator(bob.id, ada.id)).toBe(
        'not-an-administrator',
      )
      expect(await admins.isAppointed(bob.id)).toBe(true)
    })

    it('counts an actor the configuration names as administering', async () => {
      const cyBinding = passkeyBinding('https://a.example', 'cy')
      const configured = createTenantAdministratorStore(handle.db, {
        configuredAdministrators: [cyBinding],
      })
      const ada = await user('ada')
      const bob = await user('bob')
      const cy = await user('cy')
      await admins.appoint(ada.id, null)
      await admins.appoint(cy.id, null)
      expect(await configured.dismissKeepingAnAdministrator(ada.id, cy.id)).toBe('dismissed')
      await admins.dismiss(cy.id)
      await admins.appoint(bob.id, null)
      // A configured actor acts without an appointment.
      expect(await configured.dismissKeepingAnAdministrator(bob.id, cy.id)).toBe('dismissed')
    })

    it('does not count another tenant’s administrator as one acting here', async () => {
      const ada = await user('ada')
      await admins.appoint(ada.id, null)
      const otherDb = tenantDatabase(handle.rawDb, 'other-tenant')
      const otherBob = await createMemberProfileStore(otherDb).ensureProfile({
        binding: passkeyBinding('https://a.example', 'bob'),
        displayName: 'bob',
      })
      await createTenantAdministratorStore(otherDb).appoint(otherBob.id, null)
      expect(await admins.dismissKeepingAnAdministrator(ada.id, otherBob.id)).toBe(
        'not-an-administrator',
      )
      expect(await admins.isAppointed(ada.id)).toBe(true)
    })
  })

  // A tenant's administrators are its own, like its users.
  it('does not see another tenant’s administrators', async () => {
    const ada = await user('ada')
    await admins.appoint(ada.id, null)
    const other = createTenantAdministratorStore(tenantDatabase(handle.rawDb, 'other-tenant'))
    expect(await other.isAppointed(ada.id)).toBe(false)
  })
})
