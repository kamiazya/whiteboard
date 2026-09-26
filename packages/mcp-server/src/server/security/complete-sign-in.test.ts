/**
 * ADR-0046 d4-d7: what happens once an external provider has vouched for a
 * subject. `completeSignIn` is the one place that turns verified claims into
 * a session — admission, account creation and invitation redemption all
 * happen here, in that order, so no route can do them differently.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inTenantTransaction, tenantDatabase } from '../store/db/tenant-database.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import {
  type CompleteSignInDeps,
  completeSignIn,
  createCompleteSignInDeps,
} from './complete-sign-in.js'
import { createInvitationStore } from './invitation-store.js'
import { createMemberProfileStore } from './member-profile-store.js'
import { type OidcProvider, providerAuthenticator, signInConfigSchema } from './sign-in-config.js'
import { createUserDeactivation } from './user-deactivation.js'

const HOUR = 60 * 60 * 1000
const T0 = 1_800_000_000_000

function provider(admission: object = {}): OidcProvider {
  const [parsed] = signInConfigSchema.parse({
    providers: [
      {
        id: 'corp',
        kind: 'oidc',
        issuer: 'https://sso.corp.example',
        clientId: 'wb',
        clientSecret: { env: 'CORP_SECRET' },
        admission,
      },
    ],
  }).providers
  if (parsed === undefined) throw new Error('unreachable')
  return parsed
}

const ada = { sub: 'ada-1', email: 'ada@corp.example', email_verified: true, name: 'Ada' }

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let deps: CompleteSignInDeps

function depsFor(tenantId?: string): CompleteSignInDeps {
  const db = tenantId === undefined ? handle.db : tenantDatabase(handle.rawDb, tenantId)
  return createCompleteSignInDeps(db, HOUR)
}

async function accountCount(): Promise<number> {
  return (await handle.rawDb.selectFrom('accounts').selectAll().execute()).length
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-complete-sign-in-'))
  handle = await createIsolatedDb({ dataDir: root })
  deps = depsFor()
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('completeSignIn — a person already here', () => {
  it('opens a session for an existing user and creates nothing', async () => {
    const binding = { authenticator: providerAuthenticator(provider()), subject: 'ada-1' }
    await deps.members.ensureProfile({ binding, displayName: 'Ada' })
    const done = await completeSignIn(deps, { provider: provider(), claims: ada, now: T0 })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(await deps.sessions.resolve(done.sessionToken, T0 + 1)).toEqual(binding)
    expect(await accountCount()).toBe(1)
  })

  // Decision 5: rules are re-checked at EVERY sign-in, so a person who left
  // the allowed domain is refused even though their user still exists.
  it('refuses an existing user who no longer satisfies the rules', async () => {
    const strict = provider({ allowedEmailDomains: ['corp.example'] })
    const binding = { authenticator: providerAuthenticator(strict), subject: 'ada-1' }
    await deps.members.ensureProfile({ binding, displayName: 'Ada' })
    const done = await completeSignIn(deps, {
      provider: strict,
      claims: { ...ada, email: 'ada@elsewhere.example' },
      now: T0,
    })
    expect(done).toEqual({ ok: false, reason: 'email_domain_not_allowed' })
  })

  // ADR-0049 decision 4: a deactivated user is refused by name, not taken for
  // a newcomer — and an invitation they arrive with is left for somebody else.
  it('refuses a deactivated user, opens no session and spends no link', async () => {
    const binding = { authenticator: providerAuthenticator(provider()), subject: 'ada-1' }
    const user = await deps.members.ensureProfile({ binding, displayName: 'Ada' })
    await createUserDeactivation(handle.db).deactivate(user.id, T0)
    const { token } = await deps.invitations.createLink({
      invitedBy: 'p-bob',
      now: T0,
      ttlMs: HOUR,
    })
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationToken: token,
      now: T0 + 1,
    })
    expect(done).toEqual({ ok: false, reason: 'deactivated' })
    expect((await deps.invitations.openLink(token, T0 + 2)).ok).toBe(true)
    expect(await accountCount()).toBe(1)
  })
})

describe('completeSignIn — somebody new', () => {
  it('refuses an uninvited person on an invitation-only provider, and creates no account', async () => {
    const done = await completeSignIn(deps, { provider: provider(), claims: ada, now: T0 })
    expect(done).toEqual({ ok: false, reason: 'not_invited' })
    expect(await accountCount()).toBe(0)
  })

  it('creates the user through a valid link and spends the link', async () => {
    const { token } = await deps.invitations.createLink({
      invitedBy: 'p-bob',
      now: T0,
      ttlMs: HOUR,
    })
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationToken: token,
      now: T0 + 1,
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.profile.displayName).toBe('Ada')
    expect(await deps.invitations.openLink(token, T0 + 2)).toEqual({
      ok: false,
      reason: 'redeemed',
    })
  })

  it('refuses a spent link, and creates no account', async () => {
    const { token } = await deps.invitations.createLink({
      invitedBy: 'p-bob',
      now: T0,
      ttlMs: HOUR,
    })
    await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationToken: token,
      now: T0,
    })
    const eve = { sub: 'eve-1', email: 'eve@corp.example', email_verified: true }
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: eve,
      invitationToken: token,
      now: T0 + 1,
    })
    expect(done).toEqual({ ok: false, reason: 'invitation_unusable' })
    expect(await accountCount()).toBe(1)
  })

  it('refuses an expired link', async () => {
    const { token } = await deps.invitations.createLink({
      invitedBy: 'p-bob',
      now: T0,
      ttlMs: HOUR,
    })
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationToken: token,
      now: T0 + HOUR,
    })
    expect(done).toEqual({ ok: false, reason: 'invitation_unusable' })
  })

  it('honours an email invitation only where the provider opted in', async () => {
    await deps.invitations.createForEmail({
      email: 'ada@corp.example',
      invitedBy: 'p-bob',
      now: T0,
      ttlMs: HOUR,
    })
    expect(await completeSignIn(deps, { provider: provider(), claims: ada, now: T0 + 1 })).toEqual({
      ok: false,
      reason: 'not_invited',
    })
    const done = await completeSignIn(deps, {
      provider: provider({ honourEmailInvitations: true }),
      claims: ada,
      now: T0 + 1,
    })
    expect(done.ok).toBe(true)
    expect(await deps.invitations.openForEmail('ada@corp.example', T0 + 2)).toBeNull()
  })

  it('does not spend a link on a person the rules refuse', async () => {
    const strict = provider({ allowedEmailDomains: ['corp.example'] })
    const { token } = await deps.invitations.createLink({
      invitedBy: 'p-bob',
      now: T0,
      ttlMs: HOUR,
    })
    const outsider = { sub: 'eve-1', email: 'eve@elsewhere.example', email_verified: true }
    const done = await completeSignIn(deps, {
      provider: strict,
      claims: outsider,
      invitationToken: token,
      now: T0 + 1,
    })
    expect(done).toEqual({ ok: false, reason: 'email_domain_not_allowed' })
    expect((await deps.invitations.openLink(token, T0 + 2)).ok).toBe(true)
  })

  it('adds a user here for an account another tenant already has, without a second account', async () => {
    await completeSignIn(depsFor('tenant-two'), {
      provider: provider({ createAccounts: true }),
      claims: ada,
      now: T0,
    })
    const { token } = await deps.invitations.createLink({
      invitedBy: 'p-bob',
      now: T0,
      ttlMs: HOUR,
    })
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationToken: token,
      now: T0 + 1,
    })
    expect(done.ok).toBe(true)
    expect(await accountCount()).toBe(1)
  })
})

describe('completeSignIn — a user that cannot be created', () => {
  // Spending the invitation and creating the user commit together: a failure
  // in between must not leave the link spent and nobody created.
  it('leaves the link unspent when creating the user fails', async () => {
    const { token } = await deps.invitations.createLink({
      invitedBy: 'p-bob',
      now: T0,
      ttlMs: HOUR,
    })
    const failing: CompleteSignInDeps = {
      ...deps,
      atomically: (fn) =>
        inTenantTransaction(handle.db, (trx) =>
          fn({
            invitations: createInvitationStore(trx),
            members: {
              ...createMemberProfileStore(trx),
              ensureProfile: async () => {
                throw new Error('disk full')
              },
            },
          }),
        ),
    }
    await expect(
      completeSignIn(failing, {
        provider: provider(),
        claims: ada,
        invitationToken: token,
        now: T0 + 1,
      }),
    ).rejects.toThrow('disk full')
    expect((await deps.invitations.openLink(token, T0 + 2)).ok).toBe(true)
  })
})

describe('completeSignIn — two people racing for one link', () => {
  // Spending before creating is what makes this hold: exactly one redemption
  // succeeds, and the loser is refused before any user exists for them.
  it('lets exactly one of them in, and creates exactly one account', async () => {
    const { token } = await deps.invitations.createLink({
      invitedBy: 'p-bob',
      now: T0,
      ttlMs: HOUR,
    })
    const eve = { sub: 'eve-1', email: 'eve@corp.example', email_verified: true }
    const results = await Promise.all(
      [ada, eve].map((claims) =>
        completeSignIn(deps, { provider: provider(), claims, invitationToken: token, now: T0 + 1 }),
      ),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'invitation_unusable' }])
    expect(await accountCount()).toBe(1)
  })
})

describe('completeSignIn — what a provider must hand over', () => {
  it('refuses claims without a string subject', async () => {
    const done = await completeSignIn(deps, {
      provider: provider({ createAccounts: true }),
      claims: { email: 'ada@corp.example' },
      now: T0,
    })
    expect(done).toEqual({ ok: false, reason: 'no_subject' })
  })
})
