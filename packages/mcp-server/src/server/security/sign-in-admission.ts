/**
 * ADR-0046 decisions 4, 5 and 8: the ONE admission decision. Every path that
 * signs a person in through an external authenticator, or creates an account
 * for one, calls this — it is not copied per path, because every failure the
 * survey behind that ADR found was a second path that skipped the first
 * path's check (signups disabled but not for SSO; a domain rule that did not
 * apply to one provider; a second factor skipped on the OAuth path).
 *
 * The order is load-bearing: the provider's rules are checked FIRST, for an
 * existing account as much as a new one, so neither an invitation nor
 * automatic creation can carry someone past them, and a person who stops
 * satisfying them is refused at their next sign-in.
 */
import type { ProviderAdmission } from './sign-in-config.js'

/** Claims the authenticator has already verified (signature, issuer, audience). */
type VerifiedClaims = Readonly<Record<string, unknown>>

type AdmissionRefusal =
  | 'email_unverified'
  | 'email_domain_not_allowed'
  | 'hosted_domain_not_allowed'
  | 'claim_not_satisfied'
  | 'not_invited'
  | 'email_invitations_disabled'
  | 'rule_refused'

export type AdmissionDecision =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: AdmissionRefusal; readonly detail?: string }

/**
 * A rule supplied in code at distribution time, for what the declarative
 * vocabulary cannot say. It sees the verified claims and answers; it cannot
 * widen admission, only refuse, since it runs after the declared rules pass.
 */
type AdmissionRule = (input: {
  readonly providerId: string
  readonly claims: VerifiedClaims
}) => { readonly admit: true } | { readonly admit: false; readonly reason: string }

export interface AdmissionInput {
  readonly providerId: string
  readonly admission: ProviderAdmission
  readonly claims: VerifiedClaims
  /** Whether the binding already resolves to an account. */
  readonly account: 'exists' | 'new'
  /** What invitation, if any, the sign-in arrived with. For `email`, the
   *  caller has already matched the invitation's address to `claims.email`. */
  readonly invitation: 'none' | 'link' | 'email'
  readonly codeRules?: readonly AdmissionRule[]
}

const ADMITTED: AdmissionDecision = { admitted: true }

function refuse(reason: AdmissionRefusal, detail?: string): AdmissionDecision {
  return detail === undefined ? { admitted: false, reason } : { admitted: false, reason, detail }
}

// Strictly `true`: a provider that answers the string "true", or omits the
// claim, has not asserted a verified address.
function emailVerified(claims: VerifiedClaims): boolean {
  return claims.email_verified === true
}

function emailDomain(claims: VerifiedClaims): string | null {
  const email = claims.email
  if (typeof email !== 'string') return null
  const at = email.lastIndexOf('@')
  return at > 0 ? email.slice(at + 1).toLowerCase() : null
}

function claimCarries(value: unknown, allowed: readonly string[]): boolean {
  const values = Array.isArray(value) ? value : [value]
  return values.some((v) => typeof v === 'string' && allowed.includes(v))
}

// Any rule that reads the email or a domain needs the provider to have
// verified the address (decision 4; the 2024 Workspace incident).
function usesEmail({ allowedEmailDomains, googleHostedDomains }: ProviderAdmission): boolean {
  return allowedEmailDomains !== undefined || googleHostedDomains !== undefined
}

function declaredRules(admission: ProviderAdmission, claims: VerifiedClaims): AdmissionDecision {
  if (usesEmail(admission) && !emailVerified(claims)) return refuse('email_unverified')

  const { allowedEmailDomains, googleHostedDomains, requiredClaims } = admission
  if (allowedEmailDomains !== undefined) {
    const domain = emailDomain(claims)
    if (domain === null || !allowedEmailDomains.includes(domain)) {
      return refuse('email_domain_not_allowed')
    }
  }
  if (googleHostedDomains !== undefined && !claimCarries(claims.hd, googleHostedDomains)) {
    return refuse('hosted_domain_not_allowed')
  }
  for (const [name, allowed] of Object.entries(requiredClaims ?? {})) {
    if (!claimCarries(claims[name], allowed)) return refuse('claim_not_satisfied')
  }
  return ADMITTED
}

function routeToAccount(input: AdmissionInput): AdmissionDecision {
  if (input.account === 'exists') return ADMITTED
  switch (input.invitation) {
    case 'link':
      return ADMITTED
    case 'email':
      if (!input.admission.honourEmailInvitations) return refuse('email_invitations_disabled')
      return emailVerified(input.claims) ? ADMITTED : refuse('email_unverified')
    case 'none':
      return input.admission.createAccounts ? ADMITTED : refuse('not_invited')
  }
}

export function admit(input: AdmissionInput): AdmissionDecision {
  const declared = declaredRules(input.admission, input.claims)
  if (!declared.admitted) return declared

  for (const rule of input.codeRules ?? []) {
    const answer = rule({ providerId: input.providerId, claims: input.claims })
    if (!answer.admit) return refuse('rule_refused', answer.reason)
  }

  return routeToAccount(input)
}
