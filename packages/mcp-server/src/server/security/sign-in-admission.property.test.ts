/**
 * Invariants of the one admission decision (ADR-0046 d4/d5), over generated
 * rule sets and claims. None of them restates `admit`'s body: each compares
 * two answers of `admit` itself, or holds an answer against a fact of its
 * input, so a property here cannot agree with a bug by construction.
 */
import { afterAll, describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import { type AdmissionInput, admit } from './sign-in-admission.js'
import { type ProviderAdmission, providerAdmissionSchema } from './sign-in-config.js'

// A small pool, so a generated rule and a generated claim actually meet.
const DOMAINS = ['corp.example', 'other.example', 'evil.corp.example'] as const
const GROUPS = ['whiteboard', 'staff'] as const

const domainsArb = fc.uniqueArray(fc.constantFrom(...DOMAINS), { minLength: 1 })

const admissionArb: fc.Arbitrary<ProviderAdmission> = fc
  .record(
    {
      createAccounts: fc.boolean(),
      honourEmailInvitations: fc.boolean(),
      allowedEmailDomains: domainsArb,
      googleHostedDomains: domainsArb,
      requiredClaims: fc.record({
        groups: fc.uniqueArray(fc.constantFrom(...GROUPS), { minLength: 1 }),
      }),
    },
    { requiredKeys: ['createAccounts', 'honourEmailInvitations'] },
  )
  .map((raw) => providerAdmissionSchema.parse(raw))

const claimsArb = fc.record(
  {
    sub: fc.constant('s-1'),
    email: fc.constantFrom(...DOMAINS).map((d) => `ada@${d}`),
    email_verified: fc.constantFrom(true, false, 'true', undefined),
    hd: fc.constantFrom(...DOMAINS),
    groups: fc.subarray([...GROUPS]),
  },
  { requiredKeys: ['sub'] },
)

const inputArb: fc.Arbitrary<AdmissionInput> = fc.record({
  providerId: fc.constant('corp'),
  admission: admissionArb,
  claims: claimsArb,
  account: fc.constantFrom('exists' as const, 'new' as const),
  invitation: fc.constantFrom('none' as const, 'link' as const, 'email' as const),
})

const usesEmail = (a: ProviderAdmission) =>
  a.allowedEmailDomains !== undefined || a.googleHostedDomains !== undefined

// Each property only asserts inside an `if`; these count how often the `if`
// was actually entered, so a generator that stopped reaching it fails here
// instead of passing vacuously.
const reached = { emailRuleAdmitted: 0, uninvited: 0, looserChecked: 0 }

describe('admit — invariants', () => {
  afterAll(() => {
    expect(reached.emailRuleAdmitted).toBeGreaterThan(0)
    expect(reached.uninvited).toBeGreaterThan(0)
    expect(reached.looserChecked).toBeGreaterThan(0)
  })

  fcTest.prop([inputArb], withDefaults())(
    'never admits on an unverified email when a rule reads the email',
    (input) => {
      if (admit(input).admitted && usesEmail(input.admission)) {
        reached.emailRuleAdmitted++
        expect(input.claims.email_verified).toBe(true)
      }
    },
  )

  // Stated as an equivalence rather than an implication: an implication only
  // bites when the declared rules pass, and a mutation that admitted every
  // uninvited account survived it for exactly that reason.
  fcTest.prop([inputArb], withDefaults())(
    'an uninvited new account gets in exactly when it could sign in and the provider creates accounts',
    (input) => {
      const couldSignIn = admit({ ...input, account: 'exists' }).admitted
      if (couldSignIn && !input.admission.createAccounts) reached.uninvited++
      expect(admit({ ...input, account: 'new', invitation: 'none' }).admitted).toBe(
        couldSignIn && input.admission.createAccounts,
      )
    },
  )

  // Monotonicity: the rules only ever narrow. Dropping one of them can never
  // turn an admission into a refusal.
  fcTest.prop(
    [inputArb, fc.constantFrom('allowedEmailDomains', 'googleHostedDomains', 'requiredClaims')],
    withDefaults(),
  )('a rule set with one rule removed admits everyone the full set admits', (input, rule) => {
    const { [rule]: _dropped, ...rest } = input.admission
    const looser = { ...input, admission: rest as ProviderAdmission }
    if (admit(input).admitted) {
      reached.looserChecked++
      expect(admit(looser).admitted).toBe(true)
    }
  })

  // An invitation link lets a NEW account in on exactly the terms an
  // existing account signs in on — it adds a route, never a rule.
  fcTest.prop([inputArb], withDefaults())(
    'an invitation link admits a new account exactly when an existing one would be',
    (input) => {
      expect(admit({ ...input, account: 'new', invitation: 'link' })).toEqual(
        admit({ ...input, account: 'exists' }),
      )
    },
  )
})
