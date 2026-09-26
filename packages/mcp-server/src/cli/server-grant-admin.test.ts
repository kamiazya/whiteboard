/**
 * ADR-0049 decision 2: the operator appoints a tenant's first administrator
 * from the machine that holds the data, the same trust `grant-member` and
 * `add-user` rest on. Administrators appoint the rest from inside the product.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemberProfileStore } from '../server/security/member-profile-store.js'
import { createTenantAdministratorStore } from '../server/security/tenant-administrator-store.js'
import { createIsolatedDb } from '../server/store/db/test-helpers.js'
import { grantAdmin, runServerGrantAdmin } from './server-grant-admin.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

const userNamed = (displayName: string, subject: string) =>
  createMemberProfileStore(handle.db).ensureProfile({
    binding: { authenticator: 'oidc:test', subject },
    displayName,
  })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-grant-admin-'))
  handle = await createIsolatedDb({ dataDir: root })
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('grantAdmin', () => {
  it('appoints a user named by id or display name, as the operator', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    expect(await grantAdmin(handle.db, { user: 'Ada', remove: false })).toEqual({
      kind: 'ok',
      user: { id: ada.id, displayName: 'Ada' },
      administrator: true,
    })
    const [appointment] = await createTenantAdministratorStore(handle.db).list()
    expect(appointment).toMatchObject({ profileId: ada.id, appointedBy: null })
  })

  it('dismisses with --remove', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    await grantAdmin(handle.db, { user: ada.id, remove: false })
    expect(await grantAdmin(handle.db, { user: ada.id, remove: true })).toMatchObject({
      kind: 'ok',
      administrator: false,
    })
    expect(await createTenantAdministratorStore(handle.db).isAppointed(ada.id)).toBe(false)
  })

  it('refuses a name nobody has, listing who there is', async () => {
    await userNamed('Ada', 'ada-1')
    expect(await grantAdmin(handle.db, { user: 'Nobody', remove: false })).toMatchObject({
      kind: 'unknown-user',
      users: [{ displayName: 'Ada' }],
    })
  })
})

describe('runServerGrantAdmin', () => {
  const run = async (args: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }
    const code = await runServerGrantAdmin([...args, `--data-dir=${root}`], io)
    return { code, stdout: out.join(''), stderr: err.join('') }
  }

  it('appoints and prints what it did as one JSON line', async () => {
    await userNamed('Ada', 'ada-1')
    const res = await run(['--json', '--user=Ada'])
    expect(res.code).toBe(0)
    expect(JSON.parse(res.stdout)).toMatchObject({ kind: 'ok', administrator: true })
  })

  it('exits 1 and names the fix when nobody matches', async () => {
    const res = await run(['--json', '--user=Nobody'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('add-user')
  })

  it('exits 64 without --user', async () => {
    expect((await run(['--json'])).code).toBe(64)
  })
})
