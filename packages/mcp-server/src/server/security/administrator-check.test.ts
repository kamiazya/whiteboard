/**
 * ADR-0049 decision 2: a person is a tenant administrator when the tenant
 * appointed them, or when the configuration names them by provider and
 * subject. The configured list is read at every check, so removing a name
 * removes the role at that person's next request.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createAdministratorCheck } from './administrator-check.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'
import { configuredAdministrators, signInConfigSchema } from './sign-in-config.js'
import { createTenantAdministratorStore } from './tenant-administrator-store.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-admin-check-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

const config = signInConfigSchema.parse({
  providers: [
    {
      id: 'corp',
      kind: 'oidc',
      issuer: 'https://sso.corp.example',
      admission: { bearerClients: ['cli'] },
    },
  ],
  administrators: [{ provider: 'corp', subject: 'ada-1' }],
})
const configured = configuredAdministrators(config)
const [ada, bob] =
  configured.length > 0 ? [configured[0]!, { ...configured[0]!, subject: 'bob-1' }] : []

describe('createAdministratorCheck', () => {
  it('admits a person the configuration names, with no appointment needed', async () => {
    const check = createAdministratorCheck({
      admins: createTenantAdministratorStore(handle.db),
      members,
      configured,
    })
    expect(await check.isAdministrator(ada!)).toBe(true)
    expect(await check.isAdministrator(bob!)).toBe(false)
  })

  it('admits a user the tenant appointed', async () => {
    const admins = createTenantAdministratorStore(handle.db)
    const user = await members.ensureProfile({ binding: bob!, displayName: 'Bob' })
    await admins.appoint(user.id, null)
    const check = createAdministratorCheck({ admins, members, configured: [] })
    expect(await check.isAdministrator(bob!)).toBe(true)
  })

  it('reads the configured list at every check', async () => {
    const list = [...configured]
    const check = createAdministratorCheck({
      admins: createTenantAdministratorStore(handle.db),
      members,
      configured: list,
    })
    expect(await check.isAdministrator(ada!)).toBe(true)
    list.length = 0
    expect(await check.isAdministrator(ada!)).toBe(false)
  })
})

describe('the configured administrators list', () => {
  it('names each administrator by the provider’s authenticator and the subject', () => {
    expect(configured).toHaveLength(1)
    expect(configured[0]?.subject).toBe('ada-1')
    expect(configured[0]?.authenticator.startsWith('oidc:')).toBe(true)
  })

  it('is refused when it names a provider the configuration does not declare', () => {
    const parsed = signInConfigSchema.safeParse({
      providers: [],
      administrators: [{ provider: 'nobody', subject: 'x' }],
    })
    expect(parsed.success).toBe(false)
  })

  // An email can be claimed by whoever registers it at a provider first; a
  // subject cannot.
  it('takes no email address', () => {
    const parsed = signInConfigSchema.safeParse({
      providers: [
        {
          id: 'corp',
          kind: 'oidc',
          issuer: 'https://sso.corp.example',
          admission: { bearerClients: ['cli'] },
        },
      ],
      administrators: [{ provider: 'corp', email: 'ada@corp.example' }],
    })
    expect(parsed.success).toBe(false)
  })
})
