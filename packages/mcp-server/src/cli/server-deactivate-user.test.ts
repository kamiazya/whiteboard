/**
 * ADR-0049 decision 4 from the operator's side: the machine that holds the
 * data can deactivate a user and reverse it, the same trust `grant-admin`
 * rests on. Administrators do the same from inside the product.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemberProfileStore } from '../server/security/member-profile-store.js'
import { providerAuthenticator, signInConfigSchema } from '../server/security/sign-in-config.js'
import { createIsolatedDb } from '../server/store/db/test-helpers.js'
import { deactivateUserOutputSchema } from './operator-json.js'
import { deactivateUser, runServerDeactivateUser } from './server-deactivate-user.js'

// A bearer-only provider, so the declaration needs no client secret.
const CORP = {
  id: 'corp',
  kind: 'oidc',
  issuer: 'https://sso.corp.example',
  admission: { bearerClients: ['ops'] },
} as const

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

const binding = { authenticator: 'oidc:test', subject: 'ada-1' }
const members = () => createMemberProfileStore(handle.db)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-deactivate-user-'))
  handle = await createIsolatedDb({ dataDir: root })
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('deactivateUser', () => {
  it('deactivates a user named by id, and reactivates them', async () => {
    const ada = await members().ensureProfile({ binding, displayName: 'Ada' })
    const user = { kind: 'id', id: ada.id } as const
    expect(await deactivateUser(handle.db, { user, reactivate: false, now: 1 })).toEqual({
      kind: 'ok',
      user: {
        id: ada.id,
        displayName: 'Ada',
        bindings: [{ provider: null, authenticator: 'oidc:test', subject: 'ada-1' }],
      },
      deactivated: true,
      changed: true,
    })
    expect(await members().isDeactivated(binding)).toBe(true)

    expect(
      await deactivateUser(handle.db, {
        user: { kind: 'id', id: ada.id },
        reactivate: true,
        now: 2,
      }),
    ).toMatchObject({ kind: 'ok', deactivated: false, changed: true })
    expect(await members().isDeactivated(binding)).toBe(false)
  })

  it('says when there was nothing to change', async () => {
    const ada = await members().ensureProfile({ binding, displayName: 'Ada' })
    const user = { kind: 'id', id: ada.id } as const
    expect(await deactivateUser(handle.db, { user, reactivate: true, now: 1 })).toMatchObject({
      kind: 'ok',
      deactivated: false,
      changed: false,
    })
  })

  // A deactivated user must stay nameable, or they could never be reactivated.
  it('finds a deactivated user by provider and subject to reactivate them', async () => {
    const corp = { authenticator: providerAuthenticator(CORP), subject: 'ada-1' }
    const ada = await members().ensureProfile({ binding: corp, displayName: 'Ada' })
    await deactivateUser(handle.db, {
      user: { kind: 'id', id: ada.id },
      reactivate: false,
      now: 1,
    })
    expect(
      await deactivateUser(handle.db, {
        user: { kind: 'binding', provider: 'corp', subject: 'ada-1' },
        reactivate: true,
        now: 2,
        providers: signInConfigSchema.parse({ providers: [CORP] }).providers,
      }),
    ).toMatchObject({ kind: 'ok', changed: true, user: { id: ada.id } })
  })
})

describe('runServerDeactivateUser', () => {
  const run = async (args: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }
    const code = await runServerDeactivateUser([...args, `--data-dir=${root}`], io)
    return { code, stdout: out.join(''), stderr: err.join('') }
  }

  it('deactivates and prints what it did as one JSON line', async () => {
    const ada = await members().ensureProfile({ binding, displayName: 'Ada' })
    const res = await run(['--json', `--user=${ada.id}`])
    expect(res.code).toBe(0)
    expect(deactivateUserOutputSchema.parse(JSON.parse(res.stdout))).toMatchObject({
      schemaVersion: 1,
      kind: 'ok',
      deactivated: true,
    })
  })

  it('exits 1 when nobody matches', async () => {
    expect((await run(['--json', '--user=Nobody'])).code).toBe(1)
  })

  it('exits 64 without --user', async () => {
    expect((await run(['--json'])).code).toBe(64)
  })

  // A display name is whatever the person's provider claims at first sign-in,
  // so a newcomer could take a colleague's name and have the colleague's
  // deactivation land on themselves, or the reverse.
  it('refuses a display name as --user, deactivating nobody', async () => {
    const attacker = { authenticator: 'oidc:test', subject: 'attacker' }
    await members().ensureProfile({ binding: attacker, displayName: 'Alice' })
    const res = await run(['--json', '--user=Alice'])
    expect(res.code).toBe(1)
    expect(JSON.parse(res.stdout)).toMatchObject({ kind: 'unknown-user' })
    expect(await members().isDeactivated(attacker)).toBe(false)
  })
})
