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
    await admins.appoint(bob.id, null)
    await admins.appoint(bob.id, ada.id)
    expect(await admins.list()).toHaveLength(1)
    expect((await admins.list())[0]?.appointedBy).toBeNull()
  })

  it('dismisses, and answers whether there was anyone to dismiss', async () => {
    const ada = await user('ada')
    await admins.appoint(ada.id, null)
    expect(await admins.dismiss(ada.id)).toBe(true)
    expect(await admins.dismiss(ada.id)).toBe(false)
    expect(await admins.isAppointed(ada.id)).toBe(false)
  })

  // A tenant's administrators are its own, like its users.
  it('does not see another tenant’s administrators', async () => {
    const ada = await user('ada')
    await admins.appoint(ada.id, null)
    const other = createTenantAdministratorStore(tenantDatabase(handle.rawDb, 'other-tenant'))
    expect(await other.isAppointed(ada.id)).toBe(false)
  })
})
