/**
 * ADR-0046 decision 5 on the bearer path: a bearer whose person has no user
 * here gets one only through the provider declared for its issuer, by the
 * same `admit()` a browser sign-in takes — and only from a client that
 * provider names, on a token that says it is an access token.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { type BearerToken, provisionBearerPerson } from './bearer-provisioning.js'
import { createMemberProfileStore, type MemberProfileStore } from './member-profile-store.js'
import { providerAuthenticator, signInConfigSchema } from './sign-in-config.js'

const ISSUER = 'https://idp.test'

function providers(admission: object) {
  return signInConfigSchema.parse({
    providers: [
      {
        id: 'corp',
        kind: 'oidc',
        issuer: ISSUER,
        clientId: 'wb-web',
        clientSecret: { env: 'CORP_SECRET' },
        admission,
      },
    ],
  }).providers
}

const person = { authenticator: providerAuthenticator({ issuer: ISSUER }), subject: 'ada-1' }

function token(claims: Record<string, unknown>, typed = true): BearerToken {
  return { typed, claims: { sub: 'ada-1', azp: 'claude-code', name: 'Ada', ...claims } }
}

const OPEN = { createAccounts: true, bearerClients: ['claude-code'] }

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-bearer-provisioning-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('provisionBearerPerson', () => {
  it('creates the user when the provider admits the token from a named client', async () => {
    const outcome = await provisionBearerPerson(
      { providers: providers(OPEN), members },
      person,
      token({}),
    )
    expect(outcome).toEqual({ ok: true })
    expect((await members.profileForBinding(person))?.displayName).toBe('Ada')
  })

  it('reads the client from client_id when the token carries no azp', async () => {
    const outcome = await provisionBearerPerson(
      { providers: providers(OPEN), members },
      person,
      token({ azp: undefined, client_id: 'claude-code' }),
    )
    expect(outcome).toEqual({ ok: true })
  })

  it.for([
    [
      'a provider that names no bearer client',
      { createAccounts: true },
      token({}),
      'bearer_accounts_disabled',
    ],
    [
      'a client the provider does not name',
      OPEN,
      token({ azp: 'other-app' }),
      'client_not_allowed',
    ],
    ['an untyped token', OPEN, token({}, false), 'untyped_access_token'],
    ['an invitation-only provider', { bearerClients: ['claude-code'] }, token({}), 'not_invited'],
    [
      'an address outside the allowed domains',
      { ...OPEN, allowedEmailDomains: ['corp.example'] },
      token({ email: 'ada@else.example', email_verified: true }),
      'email_domain_not_allowed',
    ],
  ] as const)('refuses %s, creating nothing', async ([, admission, bearer, reason]) => {
    const outcome = await provisionBearerPerson(
      { providers: providers(admission), members },
      person,
      bearer,
    )
    expect(outcome).toEqual({ ok: false, reason })
    expect(await members.profileForBinding(person)).toBeNull()
  })

  it('answers no provider for an issuer nobody declared, creating nothing', async () => {
    const stranger = {
      authenticator: providerAuthenticator({ issuer: 'https://other.test' }),
      subject: 'x',
    }
    const outcome = await provisionBearerPerson(
      { providers: providers(OPEN), members },
      stranger,
      token({}),
    )
    expect(outcome).toEqual({ ok: false, reason: 'no_provider' })
  })

  // Two first requests for one person: the loser's binding insert hits the
  // primary key after the winner committed. The loser answers with the
  // winner's user rather than a 500.
  it('answers the winning user when a concurrent first request created it', async () => {
    const winner = await members.ensureProfile({ binding: person, displayName: 'Ada' })
    const loser: MemberProfileStore = {
      ...members,
      ensureProfile: async () => {
        throw new Error('UNIQUE constraint failed: accountBindings')
      },
    }
    const outcome = await provisionBearerPerson(
      { providers: providers(OPEN), members: loser },
      person,
      token({}),
    )
    expect(outcome).toEqual({ ok: true })
    expect((await members.profileForBinding(person))?.id).toBe(winner.id)
  })

  it('rethrows a failure that left no user behind', async () => {
    const broken: MemberProfileStore = {
      ...members,
      ensureProfile: async () => {
        throw new Error('disk full')
      },
    }
    await expect(
      provisionBearerPerson({ providers: providers(OPEN), members: broken }, person, token({})),
    ).rejects.toThrow('disk full')
  })
})
