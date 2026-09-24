/**
 * ADR-0046 decision 5 on the bearer path: a validated bearer whose person has
 * no user in this tenant gets one only through the provider declared for its
 * issuer, by the same `admit()` a browser sign-in takes.
 *
 * Three conditions sit in front of `admit()`, because an access token is not
 * an ID token: signature, issuer and audience prove the token was minted for
 * this keeper, not by which client or with what claim semantics.
 *   - The provider must name the clients (`azp`/`client_id`) allowed to create
 *     users this way. Without the list, no bearer creates anyone — so any
 *     other client able to obtain this audience cannot.
 *   - The token must have been typed as an access token (RFC 9068), even when
 *     the validator was told to accept untyped ones for ordinary requests.
 *   - Invitations cannot ride a bearer, so only `createAccounts` admits.
 *
 * Only creation is decided here. A person who already has a user is not
 * re-admitted per request, the same as a browser session between sign-ins.
 */

import { displayNameFrom } from './complete-sign-in.js'
import type { AuthenticatorBinding, MemberProfileStore } from './member-profile-store.js'
import {
  type AdmissionRefusal,
  type AdmissionRule,
  admit,
  type VerifiedClaims,
} from './sign-in-admission.js'
import { type OidcProvider, providerAuthenticator } from './sign-in-config.js'

export interface BearerToken {
  readonly claims: VerifiedClaims
  /** Whether the token declared itself an access token (`typ: at+jwt` or `token_use: access`). */
  readonly typed: boolean
}

export interface BearerProvisioning {
  readonly providers: readonly OidcProvider[]
  readonly members: MemberProfileStore
  readonly codeRules?: readonly AdmissionRule[]
}

type BearerProvisioningRefusal =
  | AdmissionRefusal
  | 'no_provider'
  | 'bearer_accounts_disabled'
  | 'client_not_allowed'
  | 'untyped_access_token'

export type BearerProvisioningOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: BearerProvisioningRefusal }

function clientOf(claims: VerifiedClaims): string | undefined {
  const client = claims.azp ?? claims.client_id
  return typeof client === 'string' ? client : undefined
}

function preconditions(
  provider: OidcProvider,
  token: BearerToken,
): BearerProvisioningRefusal | undefined {
  const clients = provider.admission.bearerClients
  if (clients === undefined) return 'bearer_accounts_disabled'
  const client = clientOf(token.claims)
  if (client === undefined || !clients.includes(client)) return 'client_not_allowed'
  if (!token.typed) return 'untyped_access_token'
  return undefined
}

export async function provisionBearerPerson(
  deps: BearerProvisioning,
  person: AuthenticatorBinding,
  token: BearerToken,
): Promise<BearerProvisioningOutcome> {
  const provider = deps.providers.find((p) => providerAuthenticator(p) === person.authenticator)
  if (provider === undefined) return { ok: false, reason: 'no_provider' }
  const precondition = preconditions(provider, token)
  if (precondition !== undefined) return { ok: false, reason: precondition }

  const decision = admit({
    providerId: provider.id,
    admission: provider.admission,
    claims: token.claims,
    account: 'new',
    invitation: 'none',
    ...(deps.codeRules === undefined ? {} : { codeRules: deps.codeRules }),
  })
  if (!decision.admitted) return { ok: false, reason: decision.reason }

  const displayName = displayNameFrom(token.claims, person.subject)
  try {
    await deps.members.ensureProfile({ binding: person, displayName })
  } catch (err) {
    // Two first requests for one person: the loser's binding insert hits the
    // primary key. The winner's user is the answer; anything else rethrows.
    if ((await deps.members.profileForBinding(person)) === null) throw err
  }
  return { ok: true }
}
