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
import { sha256Hex } from '../../shared/sha256.js'
import { inTenantTransaction, tenantDatabase } from '../store/db/tenant-database.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { oidcProviders } from './_test-helpers.js'
import {
  type CompleteSignInDeps,
  completeSignIn,
  createCompleteSignInDeps,
} from './complete-sign-in.js'
import { createInvitationStore } from './invitation-store.js'
import { createMemberProfileStore } from './member-profile-store.js'
import { type OidcProvider, providerAuthenticator, signInConfigSchema } from './sign-in-config.js'
import { createTenantAdministratorStore } from './tenant-administrator-store.js'
import { createUserDeactivation } from './user-deactivation.js'
import { createWorkspaceRoles } from './workspace-roles.js'

const HOUR = 60 * 60 * 1000
const T0 = 1_800_000_000_000

function provider(admission: object = {}): OidcProvider {
  const [parsed] = oidcProviders(
    signInConfigSchema.parse({
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
    }).providers,
  )
  if (parsed === undefined) throw new Error('unreachable')
  return parsed
}

const ada = { sub: 'ada-1', email: 'ada@corp.example', email_verified: true, name: 'Ada' }

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let deps: CompleteSignInDeps
/** Who mints every link here: an administrator of the tenant and the owner of `ws-1`. */
let bob: string

function depsFor(tenantId?: string): CompleteSignInDeps {
  const db = tenantId === undefined ? handle.db : tenantDatabase(handle.rawDb, tenantId)
  return createCompleteSignInDeps(db, HOUR)
}

// Every account but the inviter's: what a sign-in under test created.
async function accountCount(): Promise<number> {
  return (await handle.rawDb.selectFrom('accounts').selectAll().execute()).length - 1
}

async function seedInviter(): Promise<string> {
  const inviter = await deps.members.ensureProfile({
    binding: { authenticator: providerAuthenticator(provider()), subject: 'bob-1' },
    displayName: 'Bob',
  })
  await deps.members.addMember('ws-1', inviter.id)
  await createTenantAdministratorStore(handle.db).appoint(inviter.id, null)
  return inviter.id
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-complete-sign-in-'))
  handle = await createIsolatedDb({ dataDir: root })
  deps = depsFor()
  bob = await seedInviter()
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

  // The session store's lifetime is the deps' own, so the cookie lifetime a
  // route sets from the same value cannot outlive the session behind it.
  it('opens a session that lasts the configured lifetime and no longer', async () => {
    const binding = { authenticator: providerAuthenticator(provider()), subject: 'ada-1' }
    await deps.members.ensureProfile({ binding, displayName: 'Ada' })
    const done = await completeSignIn(deps, { provider: provider(), claims: ada, now: T0 })
    if (!done.ok) throw new Error('sign-in refused')
    expect(await deps.sessions.resolve(done.sessionToken, T0 + HOUR - 1)).toEqual(binding)
    expect(await deps.sessions.resolve(done.sessionToken, T0 + HOUR + 1)).toBeNull()
  })

  // ADR-0051 decision 5: administration asks how recently the provider
  // authenticated the person, which the ID token's `auth_time` (seconds) says.
  it('records when the provider authenticated the person, and nothing when it did not say', async () => {
    const binding = { authenticator: providerAuthenticator(provider()), subject: 'ada-1' }
    await deps.members.ensureProfile({ binding, displayName: 'Ada' })
    const said = await completeSignIn(deps, {
      provider: provider(),
      claims: { ...ada, auth_time: 1_700_000_000 },
      now: T0,
    })
    const silent = await completeSignIn(deps, { provider: provider(), claims: ada, now: T0 })
    if (!said.ok || !silent.ok) throw new Error('sign-in refused')
    expect((await deps.sessions.open(said.sessionToken, T0 + 1))?.authenticatedAt).toBe(
      1_700_000_000_000,
    )
    expect((await deps.sessions.open(silent.sessionToken, T0 + 1))?.authenticatedAt).toBeNull()
  })

  // A malformed `auth_time` must not become a stored authentication time
  // that administration would then read as fresh or stale at random.
  it.for([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['a string', '1700000000'],
  ] as const)('records no authentication time for an auth_time that is %s', async ([, bad]) => {
    const binding = { authenticator: providerAuthenticator(provider()), subject: 'ada-1' }
    await deps.members.ensureProfile({ binding, displayName: 'Ada' })
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: { ...ada, auth_time: bad },
      now: T0,
    })
    if (!done.ok) throw new Error('sign-in refused')
    expect((await deps.sessions.open(done.sessionToken, T0 + 1))?.authenticatedAt).toBeNull()
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
      invitedBy: bob,
      now: T0,
      ttlMs: HOUR,
    })
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationTokenHash: sha256Hex(token),
      now: T0 + 1,
    })
    expect(done).toEqual({ ok: false, reason: 'deactivated' })
    expect((await deps.invitations.openLink(token, T0 + 2)).ok).toBe(true)
    expect(await accountCount()).toBe(1)
  })
})

// The deactivation check runs before the session is opened, so a
// deactivation landing in between must not leave a session behind it — one
// that reactivating would bring back, since reactivating ends nothing.
describe('completeSignIn — a deactivation racing the sign-in', () => {
  it('opens no session when the user is deactivated after the check', async () => {
    const binding = { authenticator: providerAuthenticator(provider()), subject: 'ada-1' }
    const user = await deps.members.ensureProfile({ binding, displayName: 'Ada' })
    const deactivation = createUserDeactivation(handle.db)
    const racing: CompleteSignInDeps = {
      ...deps,
      // The last step before the session opens: deactivate there.
      atomically: async (fn) => {
        const out = await deps.atomically(fn)
        await deactivation.deactivate(user.id, T0)
        return out
      },
    }
    const done = await completeSignIn(racing, { provider: provider(), claims: ada, now: T0 })
    expect(done).toEqual({ ok: false, reason: 'deactivated' })

    await deactivation.reactivate(user.id)
    const sessions = await handle.rawDb
      .selectFrom('signInSessions')
      .select('tokenHash')
      .where('subject', '=', 'ada-1')
      .execute()
    expect(sessions).toEqual([])
  })
})

describe('completeSignIn — somebody new', () => {
  it('refuses an uninvited person on an invitation-only provider, and creates no account', async () => {
    const done = await completeSignIn(deps, { provider: provider(), claims: ada, now: T0 })
    expect(done).toEqual({ ok: false, reason: 'not_invited' })
    expect(await accountCount()).toBe(0)
  })

  it('admits an uninvited person where the provider opens accounts, and creates their account', async () => {
    const done = await completeSignIn(deps, {
      provider: provider({ createAccounts: true }),
      claims: ada,
      now: T0,
    })
    expect(done.ok).toBe(true)
    expect(await accountCount()).toBe(1)
  })

  // A blank claim is no name at all, so the next claim in line names them.
  it('names a new user from the first non-blank display claim, trimmed', async () => {
    const open = provider({ createAccounts: true })
    const blank = await completeSignIn(deps, {
      provider: open,
      claims: { sub: 's-1', name: '   ', preferred_username: 'ada' },
      now: T0,
    })
    const padded = await completeSignIn(deps, {
      provider: open,
      claims: { sub: 's-2', name: '  Bob  ' },
      now: T0,
    })
    if (!blank.ok || !padded.ok) throw new Error('sign-in refused')
    expect(blank.profile.displayName).toBe('ada')
    expect(padded.profile.displayName).toBe('Bob')
  })

  it('creates the user through a valid link and spends the link', async () => {
    const { token } = await deps.invitations.createLink({
      invitedBy: bob,
      now: T0,
      ttlMs: HOUR,
    })
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationTokenHash: sha256Hex(token),
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
      invitedBy: bob,
      now: T0,
      ttlMs: HOUR,
    })
    await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationTokenHash: sha256Hex(token),
      now: T0,
    })
    const eve = { sub: 'eve-1', email: 'eve@corp.example', email_verified: true }
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: eve,
      invitationTokenHash: sha256Hex(token),
      now: T0 + 1,
    })
    expect(done).toEqual({ ok: false, reason: 'invitation_unusable' })
    expect(await accountCount()).toBe(1)
  })

  it('refuses an expired link', async () => {
    const { token } = await deps.invitations.createLink({
      invitedBy: bob,
      now: T0,
      ttlMs: HOUR,
    })
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationTokenHash: sha256Hex(token),
      now: T0 + HOUR,
    })
    expect(done).toEqual({ ok: false, reason: 'invitation_unusable' })
  })

  it('does not spend a link on a person the rules refuse', async () => {
    const strict = provider({ allowedEmailDomains: ['corp.example'] })
    const { token } = await deps.invitations.createLink({
      invitedBy: bob,
      now: T0,
      ttlMs: HOUR,
    })
    const outsider = { sub: 'eve-1', email: 'eve@elsewhere.example', email_verified: true }
    const done = await completeSignIn(deps, {
      provider: strict,
      claims: outsider,
      invitationTokenHash: sha256Hex(token),
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
      invitedBy: bob,
      now: T0,
      ttlMs: HOUR,
    })
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationTokenHash: sha256Hex(token),
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
      invitedBy: bob,
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
        invitationTokenHash: sha256Hex(token),
        now: T0 + 1,
      }),
    ).rejects.toThrow('disk full')
    expect((await deps.invitations.openLink(token, T0 + 2)).ok).toBe(true)
  })
})

// ADR-0049 decision 3: an invitation invites a person into a workspace, and
// accepting it makes them a user if they are not one, and a member, in one step.
describe('completeSignIn — an invitation into a workspace', () => {
  const binding = () => ({ authenticator: providerAuthenticator(provider()), subject: 'ada-1' })
  const workspaceLink = () =>
    deps.invitations.createLink({ invitedBy: bob, workspaceId: 'ws-1', now: T0, ttlMs: HOUR })

  it('makes a newcomer a user and a member of that workspace', async () => {
    const { token } = await workspaceLink()
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationTokenHash: sha256Hex(token),
      now: T0 + 1,
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(await deps.members.isWorkspaceMember('ws-1', done.profile.id)).toBe('member')
    expect((await deps.invitations.openLink(token, T0 + 2)).ok).toBe(false)
  })

  it('makes an existing user a member, and spends the link', async () => {
    const user = await deps.members.ensureProfile({ binding: binding(), displayName: 'Ada' })
    const { token } = await workspaceLink()
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationTokenHash: sha256Hex(token),
      now: T0 + 1,
    })
    expect(done.ok).toBe(true)
    expect(await deps.members.isWorkspaceMember('ws-1', user.id)).toBe('member')
    expect(await deps.invitations.openLink(token, T0 + 2)).toEqual({
      ok: false,
      reason: 'redeemed',
    })
  })

  // The link would add nobody, so spending it would only take it from the
  // person it was meant for.
  it('leaves a workspace link unspent for a user already a member of it', async () => {
    const user = await deps.members.ensureProfile({ binding: binding(), displayName: 'Ada' })
    await deps.members.addMember('ws-1', user.id)
    const { token } = await workspaceLink()
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationTokenHash: sha256Hex(token),
      now: T0 + 1,
    })
    expect(done.ok).toBe(true)
    expect(await deps.members.isWorkspaceMember('ws-1', user.id)).toBe('member')
    expect((await deps.invitations.openLink(token, T0 + 2)).ok).toBe(true)
  })

  // An invitation to the tenant alone makes a user; an existing one has no
  // use for it, so it stays for whoever it was meant for.
  it('leaves an invitation that names no workspace unspent for an existing user', async () => {
    await deps.members.ensureProfile({ binding: binding(), displayName: 'Ada' })
    const { token } = await deps.invitations.createLink({
      invitedBy: bob,
      now: T0,
      ttlMs: HOUR,
    })
    await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationTokenHash: sha256Hex(token),
      now: T0 + 1,
    })
    expect((await deps.invitations.openLink(token, T0 + 2)).ok).toBe(true)
  })

  // A link that no longer opens is refused only to a NEWCOMER, who needs it to
  // get in; a person already here signs in as themselves, joining nothing.
  it('signs in an existing user who arrives with an expired link', async () => {
    const user = await deps.members.ensureProfile({ binding: binding(), displayName: 'Ada' })
    const { token } = await workspaceLink()
    const done = await completeSignIn(deps, {
      provider: provider(),
      claims: ada,
      invitationTokenHash: sha256Hex(token),
      now: T0 + HOUR,
    })
    expect(done.ok).toBe(true)
    expect(await deps.members.isWorkspaceMember('ws-1', user.id)).not.toBe('member')
  })
})

describe('completeSignIn — rules supplied in code', () => {
  // A code rule refuses what the declared rules admit, and sees the provider
  // and the verified claims; it is how a distribution narrows admission.
  it('refuses a person a code rule refuses, handing the rule the provider and claims', async () => {
    const seen: unknown[] = []
    const withRule: CompleteSignInDeps = {
      ...deps,
      codeRules: [
        (input) => {
          seen.push(input)
          return { admit: false, reason: 'not on the roster' }
        },
      ],
    }
    const done = await completeSignIn(withRule, {
      provider: provider({ createAccounts: true }),
      claims: ada,
      now: T0,
    })
    expect(done).toEqual({ ok: false, reason: 'rule_refused' })
    expect(seen).toEqual([{ providerId: 'corp', claims: ada }])
    expect(await accountCount()).toBe(0)
  })

  it('lets a person through when every code rule admits them', async () => {
    const withRule: CompleteSignInDeps = { ...deps, codeRules: [() => ({ admit: true })] }
    const done = await completeSignIn(withRule, {
      provider: provider({ createAccounts: true }),
      claims: ada,
      now: T0,
    })
    expect(done.ok).toBe(true)
  })
})

describe('completeSignIn — two people racing for one link', () => {
  // Spending before creating is what makes this hold: exactly one redemption
  // succeeds, and the loser is refused before any user exists for them.
  it('lets exactly one of them in, and creates exactly one account', async () => {
    const { token } = await deps.invitations.createLink({
      invitedBy: bob,
      now: T0,
      ttlMs: HOUR,
    })
    const eve = { sub: 'eve-1', email: 'eve@corp.example', email_verified: true }
    const results = await Promise.all(
      [ada, eve].map((claims) =>
        completeSignIn(deps, {
          provider: provider(),
          claims,
          invitationTokenHash: sha256Hex(token),
          now: T0 + 1,
        }),
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

  // An empty subject is one every provider could send, so binding it would
  // hand one user to everybody whose token carries it.
  it('refuses an empty subject', async () => {
    const done = await completeSignIn(deps, {
      provider: provider({ createAccounts: true }),
      claims: { sub: '' },
      now: T0,
    })
    expect(done).toEqual({ ok: false, reason: 'no_subject' })
    expect(await accountCount()).toBe(0)
  })
})

// An invitation speaks with its inviter's authority, so it is spent only while
// they still hold it: an owner of the workspace it invites into, or an
// administrator for one into the tenant alone — and in either case active.
describe('completeSignIn — an inviter who has since lost their authority', () => {
  const newcomer = { sub: 'eve-1', email: 'eve@corp.example', email_verified: true }
  const workspaceLink = () =>
    deps.invitations.createLink({ invitedBy: bob, workspaceId: 'ws-1', now: T0, ttlMs: HOUR })
  const redeemWith = (token: string, claims: typeof newcomer = newcomer) =>
    completeSignIn(deps, {
      provider: provider(),
      claims,
      invitationTokenHash: sha256Hex(token),
      now: T0 + 1,
    })
  const roles = () => createWorkspaceRoles(handle.db)
  async function secondOwner(): Promise<string> {
    const ada = await deps.members.ensureProfile({
      binding: { authenticator: providerAuthenticator(provider()), subject: 'ada-1' },
      displayName: 'Ada',
    })
    await deps.members.addMember('ws-1', ada.id)
    await roles().setRole('ws-1', ada.id, 'owner')
    return ada.id
  }

  it('refuses a removed owner who redeems their own link back into the workspace', async () => {
    await secondOwner()
    const { token } = await workspaceLink()
    expect(await roles().remove('ws-1', bob)).toBe('ok')
    const done = await redeemWith(token, {
      sub: 'bob-1',
      email: 'bob@corp.example',
      email_verified: true,
    })
    expect(done).toEqual({ ok: false, reason: 'invitation_unusable' })
    expect((await roles().list('ws-1')).map((m) => m.profile.id)).not.toContain(bob)
  })

  it('refuses a newcomer on a link from an owner since demoted to member', async () => {
    await secondOwner()
    const { token } = await workspaceLink()
    expect(await roles().setRole('ws-1', bob, 'member')).toBe('ok')
    expect(await redeemWith(token)).toEqual({ ok: false, reason: 'invitation_unusable' })
    expect(await accountCount()).toBe(1)
  })

  it('refuses a newcomer on a workspace link from an inviter since deactivated', async () => {
    const { token } = await workspaceLink()
    await createUserDeactivation(handle.db).deactivate(bob, T0)
    expect(await redeemWith(token)).toEqual({ ok: false, reason: 'invitation_unusable' })
    expect(await accountCount()).toBe(0)
  })

  it('refuses a newcomer on a tenant link from an administrator since dismissed', async () => {
    const { token } = await deps.invitations.createLink({ invitedBy: bob, now: T0, ttlMs: HOUR })
    await createTenantAdministratorStore(handle.db).dismiss(bob)
    expect(await redeemWith(token)).toEqual({ ok: false, reason: 'invitation_unusable' })
    expect(await accountCount()).toBe(0)
  })

  it('refuses a newcomer on a tenant link from an administrator since deactivated', async () => {
    const { token } = await deps.invitations.createLink({ invitedBy: bob, now: T0, ttlMs: HOUR })
    await createUserDeactivation(handle.db).deactivate(bob, T0)
    expect(await redeemWith(token)).toEqual({ ok: false, reason: 'invitation_unusable' })
  })

  // The configuration's administrators are no rows, so the guard matches
  // them by binding; one the configuration stops naming loses the link too.
  it('admits a newcomer on a tenant link from an administrator the configuration names', async () => {
    const carolBinding = { authenticator: providerAuthenticator(provider()), subject: 'carol-1' }
    const carol = await deps.members.ensureProfile({ binding: carolBinding, displayName: 'Carol' })
    const { token } = await deps.invitations.createLink({
      invitedBy: carol.id,
      now: T0,
      ttlMs: HOUR,
    })
    expect(await redeemWith(token)).toEqual({ ok: false, reason: 'invitation_unusable' })
    deps = createCompleteSignInDeps(handle.db, HOUR, [
      { authenticator: 'oidc:https://elsewhere.example', subject: 'carol-1' },
      carolBinding,
    ])
    expect((await redeemWith(token)).ok).toBe(true)
  })

  it('still admits a newcomer on a link whose inviter keeps their authority', async () => {
    const { token } = await workspaceLink()
    const done = await redeemWith(token)
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(await deps.members.membershipRole('ws-1', done.profile.id)).toBe('member')
  })
})
