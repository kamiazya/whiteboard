/**
 * ADR-0046 decisions 4, 5 and 8: ONE admission function every sign-in and
 * account-creating path calls. Each case below is one of the failure shapes
 * the survey behind that ADR found in shipped products.
 */
import { describe, expect, it } from 'vitest'
import { type AdmissionInput, admit } from './sign-in-admission.js'
import { providerAdmissionSchema } from './sign-in-config.js'

const verified = { sub: 's-1', email: 'ada@corp.example', email_verified: true }

function input(overrides: Partial<AdmissionInput> & { rules?: object }): AdmissionInput {
  const { rules, ...rest } = overrides
  return {
    providerId: 'corp',
    admission: providerAdmissionSchema.parse(rules ?? {}),
    claims: verified,
    account: 'exists',
    invitation: 'none',
    ...rest,
  }
}

describe('admit — who may sign in at all', () => {
  it('admits an existing account when the provider declares no rules', () => {
    expect(admit(input({}))).toEqual({ admitted: true })
  })

  it('refuses a domain outside the allowed list', () => {
    const refused = admit(
      input({
        rules: { allowedEmailDomains: ['corp.example'] },
        claims: { ...verified, email: 'eve@elsewhere.example' },
      }),
    )
    expect(refused).toEqual({ admitted: false, reason: 'email_domain_not_allowed' })
  })

  it('matches the domain case-insensitively and exactly — a subdomain is not the domain', () => {
    const rules = { allowedEmailDomains: ['corp.example'] }
    expect(admit(input({ rules, claims: { ...verified, email: 'Ada@CORP.example' } }))).toEqual({
      admitted: true,
    })
    expect(
      admit(input({ rules, claims: { ...verified, email: 'ada@evil.corp.example' } })),
    ).toEqual({ admitted: false, reason: 'email_domain_not_allowed' })
  })

  // The shape of the 2024 Google Workspace incident: a domain claim is only
  // as good as the provider's own verification of the address.
  it('refuses a matching domain the provider has not verified', () => {
    const rules = { allowedEmailDomains: ['corp.example'] }
    for (const email_verified of [false, undefined, 'true']) {
      expect(
        admit(input({ rules, claims: { sub: 's-1', email: verified.email, email_verified } })),
      ).toEqual({ admitted: false, reason: 'email_unverified' })
    }
  })

  it("checks Google's hosted-domain claim, and still requires a verified email", () => {
    const rules = { googleHostedDomains: ['corp.example'] }
    expect(admit(input({ rules, claims: { ...verified, hd: 'corp.example' } }))).toEqual({
      admitted: true,
    })
    expect(admit(input({ rules, claims: { ...verified, hd: 'other.example' } }))).toEqual({
      admitted: false,
      reason: 'hosted_domain_not_allowed',
    })
    // A personal Gmail account carries no `hd` at all.
    expect(admit(input({ rules, claims: verified }))).toEqual({
      admitted: false,
      reason: 'hosted_domain_not_allowed',
    })
    expect(
      admit(input({ rules, claims: { ...verified, hd: 'corp.example', email_verified: false } })),
    ).toEqual({ admitted: false, reason: 'email_unverified' })
  })

  it('requires every listed claim to carry one of its allowed values', () => {
    const rules = { requiredClaims: { groups: ['whiteboard'], acr: ['mfa'] } }
    expect(
      admit(input({ rules, claims: { ...verified, groups: ['staff', 'whiteboard'], acr: 'mfa' } })),
    ).toEqual({ admitted: true })
    expect(admit(input({ rules, claims: { ...verified, groups: ['staff'], acr: 'mfa' } }))).toEqual(
      { admitted: false, reason: 'claim_not_satisfied' },
    )
    expect(admit(input({ rules, claims: { ...verified, groups: ['whiteboard'] } }))).toEqual({
      admitted: false,
      reason: 'claim_not_satisfied',
    })
  })
})

describe('admit — who may get a NEW account', () => {
  // Invitation-only by default (decision 4): a provider that authenticates
  // someone nobody invited does not thereby let them in.
  it('refuses a new account with no invitation when the provider does not create accounts', () => {
    expect(admit(input({ account: 'new' }))).toEqual({ admitted: false, reason: 'not_invited' })
  })

  it('admits a new account through an invitation link, with no email trusted', () => {
    expect(admit(input({ account: 'new', invitation: 'link', claims: { sub: 's-1' } }))).toEqual({
      admitted: true,
    })
  })

  it('honours an email invitation only where the provider opted in, and only verified', () => {
    expect(admit(input({ account: 'new', invitation: 'email' }))).toEqual({
      admitted: false,
      reason: 'email_invitations_disabled',
    })
    const rules = { honourEmailInvitations: true }
    expect(admit(input({ rules, account: 'new', invitation: 'email' }))).toEqual({
      admitted: true,
    })
    expect(
      admit(
        input({
          rules,
          account: 'new',
          invitation: 'email',
          claims: { ...verified, email_verified: false },
        }),
      ),
    ).toEqual({ admitted: false, reason: 'email_unverified' })
  })

  it('creates an account on its own only when the provider opted in', () => {
    expect(admit(input({ rules: { createAccounts: true }, account: 'new' }))).toEqual({
      admitted: true,
    })
  })

  // Vaultwarden's SSO_SIGNUPS_ALLOWED: a switch that closed one creation path
  // and not another. Here the rules are checked BEFORE the route to an
  // account, so an invitation cannot carry someone past them.
  it('never lets an invitation or auto-creation bypass the sign-in rules', () => {
    const rules = { allowedEmailDomains: ['corp.example'], createAccounts: true }
    const outsider = { ...verified, email: 'eve@elsewhere.example' }
    for (const invitation of ['none', 'link', 'email'] as const) {
      expect(admit(input({ rules, account: 'new', invitation, claims: outsider }))).toEqual({
        admitted: false,
        reason: 'email_domain_not_allowed',
      })
    }
  })
})

describe('admit — rules supplied in code (decision 8)', () => {
  it('runs every code rule after the declared ones, and names the refusal', () => {
    const rules = [
      () => ({ admit: true as const }),
      ({ claims }: { claims: Record<string, unknown> }) =>
        claims.department === 'design'
          ? ({ admit: true } as const)
          : ({ admit: false, reason: 'not in design' } as const),
    ]
    expect(
      admit(input({ codeRules: rules, claims: { ...verified, department: 'design' } })),
    ).toEqual({ admitted: true })
    expect(admit(input({ codeRules: rules }))).toEqual({
      admitted: false,
      reason: 'rule_refused',
      detail: 'not in design',
    })
  })
})
