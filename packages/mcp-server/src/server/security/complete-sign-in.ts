/**
 * ADR-0046 decisions 4-7: what happens once an external provider has vouched
 * for a subject. This is the ONE place verified claims become a session, so
 * the order below is the policy, and no route can reorder it:
 *
 *   1. resolve the binding to this tenant's user, if there is one;
 *   2. for a newcomer, find the invitation they arrived with;
 *   3. admit — the provider's rules, then code rules, then the route in;
 *   4. only then spend the invitation and create the user;
 *   5. open the session.
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
  type VerifiedClaims,
} from './sign-in-admission.js'
import { type OidcProvider, providerAuthenticator } from './sign-in-config.js'
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
): CompleteSignInDeps {
  return {
    members: createMemberProfileStore(db),
    invitations: createInvitationStore(db),
    sessions: createSignInSessionStore(db),
    sessionTtlMs,
    atomically: (fn) =>
      inTenantTransaction(db, (trx) =>
        fn({ members: createMemberProfileStore(trx), invitations: createInvitationStore(trx) }),
      ),
  }
}

interface CompleteSignInInput {
  readonly provider: OidcProvider
  /** Claims the relying party has already verified (signature, iss, aud, nonce). */
  readonly claims: VerifiedClaims
  /** The link token a newcomer arrived with, if any. */
  readonly invitationToken?: string
  readonly now: number
}

type SignInRefusal = AdmissionRefusal | 'invitation_unusable' | 'no_subject'

type CompleteSignInResult =
  | { readonly ok: true; readonly sessionToken: string; readonly profile: MemberProfile }
  | { readonly ok: false; readonly reason: SignInRefusal }

type ArrivedWith =
  | { readonly kind: 'link' | 'email'; readonly id: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unusable' }

async function arrivedWith(
  deps: CompleteSignInDeps,
  { provider, claims, invitationToken, now }: CompleteSignInInput,
): Promise<ArrivedWith> {
  if (invitationToken !== undefined) {
    const opened = await deps.invitations.openLink(invitationToken, now)
    return opened.ok ? { kind: 'link', id: opened.invitation.id } : { kind: 'unusable' }
  }
  // Looked up only where the operator opted in, and only for an address the
  // provider verified; `admit` checks the verification again, on purpose.
  if (
    provider.admission.honourEmailInvitations &&
    claims.email_verified === true &&
    typeof claims.email === 'string'
  ) {
    const invitation = await deps.invitations.openForEmail(claims.email, now)
    if (invitation !== null) return { kind: 'email', id: invitation.id }
  }
  return { kind: 'none' }
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

  const existing = await deps.members.profileForBinding(binding)
  // An existing user's invitation is left unspent: it was meant for somebody.
  const arrived: ArrivedWith = existing === null ? await arrivedWith(deps, input) : { kind: 'none' }
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

  let profile = existing
  if (profile === null) {
    profile = await deps.atomically(async ({ members, invitations }) => {
      const spent =
        arrived.kind === 'none' ||
        (await invitations.redeem(arrived.id, JSON.stringify(binding), now))
      if (!spent) return null
      return members.ensureProfile({ binding, displayName: displayNameFrom(claims, sub) })
    })
    if (profile === null) return refuse('invitation_unusable')
  }

  const sessionToken = await deps.sessions.create(binding, now, deps.sessionTtlMs)
  return { ok: true, sessionToken, profile }
}
