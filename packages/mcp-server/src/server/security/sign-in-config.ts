/**
 * ADR-0046 decision 3: the external identity providers a keeper accepts, and
 * the rules each admits people by, declared in configuration and validated by
 * this one schema. Secrets are REFERENCED (an environment variable or a file),
 * never written inline, so the configuration can be read and versioned
 * without handing anyone the credential.
 */
import { z } from 'zod'

// A bare lowercase domain. An `@`, a scheme or a wildcard is refused rather
// than guessed at: `*.corp.example` reads like it admits subdomains, and this
// vocabulary deliberately has no way to say that (see `admit`).
const domainSchema = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
    message: 'a bare lowercase domain, such as corp.example',
  })

export const providerAdmissionSchema = z
  .object({
    // Decision 4: invitation-only unless the operator says otherwise.
    createAccounts: z.boolean().default(false),
    // Decision 6: an invitation addressed to an email, honoured only when this
    // provider asserts the same address verified.
    honourEmailInvitations: z.boolean().default(false),
    allowedEmailDomains: z.array(domainSchema).min(1).optional(),
    // Google's `hd` claim: the Workspace domain the account belongs to.
    googleHostedDomains: z.array(domainSchema).min(1).optional(),
    // Each named claim must carry one of the listed values (a claim that is an
    // array satisfies the rule when any element matches).
    requiredClaims: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)).optional(),
  })
  .strict()

const secretReferenceSchema = z.union([
  z.object({ env: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).strict(),
  z.object({ file: z.string().min(1) }).strict(),
])

const oidcProviderSchema = z
  .object({
    // What a sign-in names ("sign in with google"). Not the authenticator:
    // see `providerAuthenticator`.
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    kind: z.literal('oidc'),
    // The issuer as its discovery document states it; the relying party
    // compares the ID token's `iss` against this exact string.
    issuer: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === 'https:', 'an https:// issuer'),
    clientId: z.string().min(1),
    clientSecret: secretReferenceSchema,
    displayName: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).default(['openid', 'email', 'profile']),
    // `prefault`, not `default`: zod 4's default is the OUTPUT value and skips
    // the inner defaults, which would leave createAccounts undefined.
    admission: providerAdmissionSchema.prefault({}),
  })
  .strict()

export const signInConfigSchema = z
  .object({ providers: z.array(oidcProviderSchema).default([]) })
  .strict()
  .superRefine(({ providers }, ctx) => {
    for (const key of ['id', 'issuer'] as const) {
      const seen = new Set<string>()
      providers.forEach((provider, index) => {
        if (seen.has(provider[key])) {
          ctx.addIssue({
            code: 'custom',
            path: ['providers', index, key],
            message: `two providers share the ${key} ${provider[key]}`,
          })
        }
        seen.add(provider[key])
      })
    }
  })

type SignInConfig = z.infer<typeof signInConfigSchema>
export type OidcProvider = SignInConfig['providers'][number]
export type ProviderAdmission = z.infer<typeof providerAdmissionSchema>

/**
 * The authenticator an account binding names for this provider. It is the
 * ISSUER, because OIDC Core 1.0 section 2 makes `sub` unique only within its
 * issuer: keyed on the operator's id, a provider re-pointed at another issuer
 * would resolve that issuer's subjects to the first one's accounts.
 */
export function providerAuthenticator(provider: Pick<OidcProvider, 'issuer'>): string {
  return `oidc:${provider.issuer}`
}
