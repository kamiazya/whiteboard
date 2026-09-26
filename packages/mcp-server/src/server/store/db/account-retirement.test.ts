/**
 * ADR-0051 decision 2: an account and its authenticator bindings go when no
 * tenant's user names the account any more. An account is keeper-wide, so
 * "no tenant" means every tenant, which only the whole database can answer.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemberProfileStore } from '../../security/member-profile-store.js'
import { retireAccountIfUnheld } from './account-retirement.js'
import { tenantDatabase } from './tenant-database.js'
import { createIsolatedDb } from './test-helpers.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
const ada = { authenticator: 'oidc:https://id.example', subject: 'ada' }

async function bindingsOf(accountId: string) {
  return handle.rawDb
    .selectFrom('accountBindings')
    .select('subject')
    .where('accountId', '=', accountId)
    .execute()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-account-retirement-'))
  handle = await createIsolatedDb({ dataDir: root })
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('retireAccountIfUnheld', () => {
  it('removes an account no tenant names, with its bindings', async () => {
    const members = createMemberProfileStore(handle.db)
    const user = await members.ensureProfile({ binding: ada, displayName: 'Ada' })
    const { accountId } = await handle.rawDb
      .selectFrom('memberProfiles')
      .select('accountId')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow()
    await handle.rawDb.deleteFrom('memberProfiles').where('id', '=', user.id).execute()

    expect(await retireAccountIfUnheld(handle.rawDb, accountId)).toBe(true)
    expect(await bindingsOf(accountId)).toEqual([])
    const account = await handle.rawDb
      .selectFrom('accounts')
      .select('id')
      .where('id', '=', accountId)
      .executeTakeFirst()
    expect(account).toBeUndefined()
  })

  it('keeps an account another tenant’s user still names', async () => {
    const here = createMemberProfileStore(handle.db)
    const there = createMemberProfileStore(tenantDatabase(handle.rawDb, 'other-tenant'))
    const user = await here.ensureProfile({ binding: ada, displayName: 'Ada' })
    await there.ensureProfile({ binding: ada, displayName: 'Ada elsewhere' })
    const { accountId } = await handle.rawDb
      .selectFrom('memberProfiles')
      .select('accountId')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow()
    await handle.rawDb.deleteFrom('memberProfiles').where('id', '=', user.id).execute()

    expect(await retireAccountIfUnheld(handle.rawDb, accountId)).toBe(false)
    expect(await bindingsOf(accountId)).toEqual([{ subject: 'ada' }])
  })
})
