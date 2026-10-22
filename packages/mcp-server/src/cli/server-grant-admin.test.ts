/**
 * ADR-0049 decision 2: the operator appoints a tenant's first administrator
 * from the machine that holds the data, the same trust `grant-member` and
 * `add-user` rest on. Administrators appoint the rest from inside the product.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signInAsNewcomer } from '../server/security/_test-helpers.js'
import { createMemberProfileStore } from '../server/security/member-profile-store.js'
import { providerAuthenticator, signInConfigSchema } from '../server/security/sign-in-config.js'
import { createTenantAdministratorStore } from '../server/security/tenant-administrator-store.js'
import { createIsolatedDb } from '../server/store/db/test-helpers.js'
import { grantAdminOutputSchema } from './operator-json.js'
import { grantAdmin, runServerGrantAdmin } from './server-grant-admin.js'

// A bearer-only provider, so the declaration needs no client secret.
const CORP = {
  id: 'corp',
  kind: 'oidc',
  issuer: 'https://sso.corp.example',
  admission: { bearerClients: ['ops'] },
} as const

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
  it('appoints a user named by id, as the operator, naming their binding', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    expect(
      await grantAdmin(handle.db, { user: { kind: 'id', id: ada.id }, remove: false }),
    ).toEqual({
      kind: 'ok',
      user: {
        id: ada.id,
        displayName: 'Ada',
        bindings: [{ provider: null, authenticator: 'oidc:test', subject: 'ada-1' }],
      },
      administrator: true,
    })
    const [appointment] = await createTenantAdministratorStore(handle.db).list()
    expect(appointment).toMatchObject({ profileId: ada.id, appointedBy: null })
  })

  it('dismisses with --remove', async () => {
    const ada = await userNamed('Ada', 'ada-1')
    await grantAdmin(handle.db, { user: { kind: 'id', id: ada.id }, remove: false })
    expect(
      await grantAdmin(handle.db, { user: { kind: 'id', id: ada.id }, remove: true }),
    ).toMatchObject({
      kind: 'ok',
      administrator: false,
    })
    expect(await createTenantAdministratorStore(handle.db).isAppointed(ada.id)).toBe(false)
  })

  it('refuses an id nobody has, listing who there is with their bindings', async () => {
    await userNamed('Ada', 'ada-1')
    expect(
      await grantAdmin(handle.db, { user: { kind: 'id', id: 'Nobody' }, remove: false }),
    ).toMatchObject({
      kind: 'unknown-user',
      users: [{ displayName: 'Ada', bindings: [{ subject: 'ada-1' }] }],
    })
  })

  it('appoints the user a provider and subject name, not a namesake elsewhere', async () => {
    const authenticator = providerAuthenticator(CORP)
    const members = createMemberProfileStore(handle.db)
    await members.ensureProfile({
      binding: { authenticator: 'oidc:elsewhere', subject: 'alice-7' },
      displayName: 'Alice',
    })
    const alice = await members.ensureProfile({
      binding: { authenticator, subject: 'alice-7' },
      displayName: 'Alice',
    })
    const outcome = await grantAdmin(handle.db, {
      user: { kind: 'binding', provider: 'corp', subject: 'alice-7' },
      remove: false,
      providers: signInConfigSchema.parse({ providers: [CORP] }).providers,
    })
    expect(outcome).toMatchObject({
      kind: 'ok',
      user: { id: alice.id, bindings: [{ provider: 'corp', authenticator, subject: 'alice-7' }] },
    })
    expect(await createTenantAdministratorStore(handle.db).list()).toMatchObject([
      { profileId: alice.id },
    ])
  })

  it('refuses a provider the configuration does not declare', async () => {
    expect(
      await grantAdmin(handle.db, {
        user: { kind: 'binding', provider: 'corp', subject: 'alice-7' },
        remove: false,
        providers: [],
      }),
    ).toEqual({ kind: 'unknown-provider', providers: [] })
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
    const ada = await userNamed('Ada', 'ada-1')
    const res = await run(['--json', `--user=${ada.id}`])
    expect(res.code).toBe(0)
    expect(grantAdminOutputSchema.parse(JSON.parse(res.stdout))).toMatchObject({
      schemaVersion: 1,
      kind: 'ok',
      administrator: true,
    })
  })

  it('exits 1 and names the fix when nobody matches', async () => {
    const res = await run(['--json', '--user=Nobody'])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('add-user')
  })

  it('exits 64 without --user', async () => {
    expect((await run(['--json'])).code).toBe(64)
  })

  it('exits 64 naming a user both by id and by binding', async () => {
    const res = await run(['--json', '--user=u1', '--provider=corp', '--subject=s'])
    expect(res.code).toBe(64)
  })

  it('exits 64 on --provider without --subject', async () => {
    expect((await run(['--json', '--provider=corp'])).code).toBe(64)
  })

  it('finds a user by --provider and --subject through the sign-in configuration', async () => {
    const configPath = join(root, 'sign-in.json')
    await writeFile(
      configPath,
      JSON.stringify({ providers: signInConfigSchema.parse({ providers: [CORP] }).providers }),
    )
    const alice = await createMemberProfileStore(handle.db).ensureProfile({
      binding: { authenticator: providerAuthenticator(CORP), subject: 'alice-7' },
      displayName: 'Alice',
    })
    const out: string[] = []
    const io = { stdout: (s: string) => out.push(s), stderr: () => {} }
    const code = await runServerGrantAdmin(
      ['--json', '--provider=corp', '--subject=alice-7', `--data-dir=${root}`],
      io,
      { WHITEBOARD_SIGN_IN_CONFIG: configPath },
    )
    expect(code).toBe(0)
    expect(JSON.parse(out.join(''))).toMatchObject({
      kind: 'ok',
      user: { id: alice.id, bindings: [{ provider: 'corp', subject: 'alice-7' }] },
    })
  })

  // A display name is whatever the person's provider claims at first sign-in,
  // so whoever signs in as "Alice" first would be the one appointed.
  it('refuses a display name as --user, appointing nobody', async () => {
    await signInAsNewcomer(handle.db, { sub: 'attacker', name: 'Alice' })
    const res = await run(['--json', '--user=Alice'])
    expect(res.code).toBe(1)
    expect(JSON.parse(res.stdout)).toMatchObject({ kind: 'unknown-user' })
    expect(res.stderr).toContain('never a display name')
    expect(await createTenantAdministratorStore(handle.db).list()).toEqual([])
  })
})
