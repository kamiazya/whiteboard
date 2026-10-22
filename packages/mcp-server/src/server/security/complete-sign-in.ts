/**
 * ADR-0046 decisions 4-7: what happens once an external provider has vouched
 * for a subject. This is the ONE place verified claims become a session, so
 * the order below is the policy, and no route can reorder it:
 *
 *   1. resolve the binding to this tenant's user, if there is one, and
 *      refuse a user an administrator has deactivated;
 *   2. for a newcomer, find the invitation they arrived with;
 *   3. admit — the provider's rules, then code rules, then the route in;
 *   4. only then spend the invitation, create the user, and add them to the
 *      workspace it invites into (ADR-0049 decision 3) — unless they are
 *      already a member of it, when the link is left unspent;
 *   5. open the session — in one write transaction with a check that the
 *      user is still active, so a deactivation racing the steps above
 *      leaves no session behind it.
 *
 * Spending comes BEFORE creating: redemption is one conditional update, so a
 * link two people race for is won by exactly one of them, and the loser is
 * refused before any user exists. The reverse order would let both in. The
 * two commit in ONE transaction, so a creation that fails leaves the link
 * unspent rather than spent on nobody.
 */

import { inTenantTransaction, type TenantDatabase } from '../store/db/tenant-database.js'
import { createInvitationStore, type InvitationStore } from './invitation-store.js'
import {
  type AuthenticatorBinding,
  createMemberProfileStore,
  type MemberProfile,
  type MemberProfileStore,
} from './member-profile-store.js'
import {
  type AdmissionRefusal,
  type AdmissionRule,
  admit,
  type RefusalOf,
  type VerifiedClaims,
} from './sign-in-admission.js'
import { providerAuthenticator, type SignInProvider } from './sign-in-config.js'
import { createSignInSessionStore, type SignInSessionStore } from './sign-in-session-store.js'

interface NewcomerStores {
  readonly members: MemberProfileStore
  readonly invitations: InvitationStore
}

export interface CompleteSignInDeps extends NewcomerStores {
  readonly sessions: SignInSessionStore
  readonly sessionTtlMs: number
  readonly codeRules?: readonly AdmissionRule[]
  /** Runs `fn` in ONE transaction over this tenant's member and invitation
   *  stores, so spending an invitation and creating the user commit together
   *  or not at all. */
  atomically<T>(fn: (stores: NewcomerStores) => Promise<T>): Promise<T>
}

/** The deps over one tenant-bound database, as the composition roots build them. */
export function createCompleteSignInDeps(
  db: TenantDatabase,
  sessionTtlMs: number,
  configuredAdministrators: readonly AuthenticatorBinding[] = [],
): CompleteSignInDeps {
  const invitationOptions = { configuredAdministrators }
  return {
    members: createMemberProfileStore(db),
    invitations: createInvitationStore(db, invitationOptions),
    sessions: createSignInSessionStore(db),
    sessionTtlMs,
    atomically: (fn) =>
      inTenantTransaction(db, (trx) =>
        fn({
          members: createMemberProfileStore(trx),
          invitations: createInvitationStore(trx, invitationOptions),
        }),
      ),
  }
}

interface CompleteSignInInput {
  readonly provider: SignInProvider
  /** Claims the relying party has already verified (signature, iss, aud, nonce). */
  readonly claims: VerifiedClaims
  /** The hash of the link token a newcomer arrived with, if any. */
  readonly invitationTokenHash?: string
  readonly now: number
}

type SignInRefusal = RefusalOf<
  AdmissionRefusal | 'invitation_unusable' | 'no_subject' | 'deactivated'
>

type CompleteSignInResult =
  | { readonly ok: true; readonly sessionToken: string; readonly profile: MemberProfile }
  | { readonly ok: false; readonly reason: SignInRefusal }

type ArrivedWith =
  | { readonly kind: 'link'; readonly id: string; readonly workspaceId: string | null }
  | { readonly kind: 'none' }
  | { readonly kind: 'unusable' }

async function arrivedWith(
  deps: CompleteSignInDeps,
  { invitationTokenHash, now }: CompleteSignInInput,
): Promise<ArrivedWith> {
  if (invitationTokenHash === undefined) return { kind: 'none' }
  const opened = await deps.invitations.openLinkByHash(invitationTokenHash, now)
  if (!opened.ok) return { kind: 'unusable' }
  return { kind: 'link', id: opened.invitation.id, workspaceId: opened.invitation.workspaceId }
}

// An existing user has no use for an invitation to the tenant, which stays
// for whoever it was meant for; one into a workspace is theirs to accept.
async function joiningWith(
  deps: CompleteSignInDeps,
  { invitationTokenHash, now }: CompleteSignInInput,
): Promise<ArrivedWith> {
  if (invitationTokenHash === undefined) return { kind: 'none' }
  const opened = await deps.invitations.openLinkByHash(invitationTokenHash, now)
  if (!opened.ok || opened.invitation.workspaceId === null) return { kind: 'none' }
  return { kind: 'link', id: opened.invitation.id, workspaceId: opened.invitation.workspaceId }
}

/** The name a new user starts with: the provider's display claims, else `fallback`. */
export function displayNameFrom(claims: VerifiedClaims, fallback: string): string {
  for (const key of ['name', 'preferred_username', 'email'] as const) {
    const value = claims[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return fallback
}

function refuse(reason: SignInRefusal): CompleteSignInResult {
  return { ok: false, reason }
}

export async function completeSignIn(
  deps: CompleteSignInDeps,
  input: CompleteSignInInput,
): Promise<CompleteSignInResult> {
  const { provider, claims, now } = input
  const sub = claims.sub
  if (typeof sub !== 'string' || sub === '') return refuse('no_subject')
  const binding: AuthenticatorBinding = {
    authenticator: providerAuthenticator(provider),
    subject: sub,
  }

  // A deactivated user is nobody to `profileForBinding`, so without this they
  // would be taken for a newcomer — and handed back their own user.
  if (await deps.members.isDeactivated(binding)) return refuse('deactivated')
  const existing = await deps.members.profileForBinding(binding)
  const arrived =
    existing === null ? await arrivedWith(deps, input) : await joiningWith(deps, input)
  if (arrived.kind === 'unusable') return refuse('invitation_unusable')

  const decision = admit({
    providerId: provider.id,
    admission: provider.admission,
    claims,
    account: existing === null ? 'new' : 'exists',
    invitation: arrived.kind,
    ...(deps.codeRules === undefined ? {} : { codeRules: deps.codeRules }),
  })
  if (!decision.admitted) return refuse(decision.reason)

  const profile = await deps.atomically((stores) =>
    enter(stores, { existing, arrived, binding, claims, now }),
  )
  if (profile === null) return refuse('invitation_unusable')

  // Null when a deactivation landed after the check above.
  const sessionToken = await openSession(deps, binding, claims, now)
  if (sessionToken === null) return refuse('deactivated')
  return { ok: true, sessionToken, profile }
}

interface Entry {
  readonly existing: MemberProfile | null
  readonly arrived: Exclude<ArrivedWith, { kind: 'unusable' }>
  readonly binding: AuthenticatorBinding
  readonly claims: VerifiedClaims
  readonly now: number
}

/** Spends the link, creates the user and joins the workspace, in one
 *  transaction; `null` when the link was not there to spend. */
async function enter(
  { members, invitations }: NewcomerStores,
  { existing, arrived, binding, claims, now }: Entry,
): Promise<MemberProfile | null> {
  // A member already in the workspace would be added to nothing, so the
  // link stays for whoever it was meant for. Read in the transaction that
  // would spend it, so a removal racing this cannot be read stale.
  if (
    existing !== null &&
    arrived.kind === 'link' &&
    arrived.workspaceId !== null &&
    (await members.membershipRole(arrived.workspaceId, existing.id)) !== null
  ) {
    return existing
  }
  const spent =
    arrived.kind === 'none' || (await invitations.redeem(arrived.id, JSON.stringify(binding), now))
  if (!spent) return null
  const user =
    existing ??
    (await members.ensureProfile({
      binding,
      displayName: displayNameFrom(claims, binding.subject),
    }))
  if (arrived.kind !== 'none' && arrived.workspaceId !== null) {
    await members.addMember(arrived.workspaceId, user.id)
  }
  return user
}

// OpenID Connect Core 1.0 section 2: `auth_time` is when the End-User
// authenticated, in seconds. ADR-0051 decision 5 reads it for administration;
// a provider that does not send it leaves the session unable to administer.
function openSession(
  deps: CompleteSignInDeps,
  binding: AuthenticatorBinding,
  claims: VerifiedClaims,
  now: number,
): Promise<string | null> {
  const at = claims.auth_time
  const authenticatedAt = typeof at === 'number' && Number.isFinite(at) ? at * 1000 : null
  return deps.sessions.createForActiveUser(binding, now, deps.sessionTtlMs, authenticatedAt)
}
