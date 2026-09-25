/**
 * ADR-0046 decision 3: the external identity providers a keeper accepts, and
 * the rules each admits people by, declared in configuration and validated by
 * this one schema. Secrets are REFERENCED (an environment variable or a file),
 * never written inline, so the configuration can be read and versioned
 * without handing anyone the credential.
 */
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
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
    // The OAuth clients (`azp`, else `client_id`) whose bearer tokens may
    // create a user through these same rules. Absent: a bearer never creates
    // one, since any client able to obtain this keeper's audience could.
    bearerClients: z.array(z.string().min(1)).min(1).optional(),
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
    // The keeper's own client at the provider, for browser sign-in. Both or
    // neither: a provider without one signs nobody in through a browser and
    // exists to admit bearers, so it must name `admission.bearerClients`.
    // Bearer verification never uses these (see bearer-provisioning.ts).
    clientId: z.string().min(1).optional(),
    clientSecret: secretReferenceSchema.optional(),
    displayName: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).default(['openid', 'email', 'profile']),
    // `prefault`, not `default`: zod 4's default is the OUTPUT value and skips
    // the inner defaults, which would leave createAccounts undefined.
    admission: providerAdmissionSchema.prefault({}),
  })
  .strict()
  .superRefine((provider, ctx) => {
    if ((provider.clientId === undefined) !== (provider.clientSecret === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [provider.clientId === undefined ? 'clientId' : 'clientSecret'],
        message: 'clientId and clientSecret are declared together, or neither is',
      })
    }
    if (provider.clientId === undefined && provider.admission.bearerClients === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['admission', 'bearerClients'],
        message:
          'a provider with no client signs nobody in through a browser; name the bearerClients it admits',
      })
    }
  })

const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', 'an https:// URL')

// An address or a CIDR range, and never every address: `0.0.0.0/0` would
// trust the header from anyone who can reach the keeper, which is exactly
// what this list exists to prevent.
const trustedAddressSchema = z.string().refine((entry) => {
  const [address = '', prefix, ...rest] = entry.split('/')
  const family = isIP(address)
  // A zone id (`fe80::1%eth0`) names an interface, which no peer address
  // compares equal to.
  if (family === 0 || rest.length > 0 || address.includes('%')) return false
  if (prefix === undefined) return true
  if (!/^\d{1,3}$/.test(prefix)) return false
  const bits = Number(prefix)
  return bits >= 1 && bits <= (family === 4 ? 32 : 128)
}, 'an IP address or a CIDR range narrower than every address, such as 10.0.0.0/8')

// Headers a proxy passes through as the CALLER sent them, or that carry a
// credential. Naming one as the identity would believe the caller.
const CALLER_HEADERS = new Set([
  'authorization',
  'cookie',
  'forwarded',
  'host',
  'proxy-authorization',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
])

const headerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]+$/, 'an HTTP header name')
  .refine(
    (name) => !CALLER_HEADERS.has(name.toLowerCase()),
    'a header the proxy sets itself, not a credential or forwarding header',
  )

/**
 * ADR-0046 decision 2: a reverse proxy that has already signed the person in
 * says who they are, and the keeper believes it only from `trustedAddresses`
 * — the immediate peer, never a forwarded-for header. A signed `assertion`
 * (Cloudflare Access, Pomerium) is checked against the proxy's keys; a bare
 * `identity` header (oauth2-proxy, Authelia) is only as good as the proxy's
 * habit of overwriting it, which is the operator's to guarantee.
 */
const trustedHeaderProviderSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    kind: z.literal('trusted-header'),
    displayName: z.string().min(1).optional(),
    trustedAddresses: z.array(trustedAddressSchema).min(1),
    assertion: z
      .object({
        header: headerNameSchema,
        issuer: httpsUrl,
        audience: z.string().min(1),
        jwksUri: httpsUrl,
      })
      .strict()
      .optional(),
    identity: z
      .object({
        subjectHeader: headerNameSchema,
        emailHeader: headerNameSchema.optional(),
        nameHeader: headerNameSchema.optional(),
        // Whether the proxy verified the address it forwards. Unverified
        // unless the operator says so, since an email rule trusts it.
        emailVerified: z.boolean().default(false),
      })
      .strict()
      .optional(),
    admission: providerAdmissionSchema.prefault({}),
  })
  .strict()
  .superRefine((provider, ctx) => {
    if ((provider.assertion === undefined) === (provider.identity === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['assertion'],
        message: 'name exactly one of assertion (a signed JWT) and identity (a bare header)',
      })
    }
    if (provider.admission.bearerClients !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['admission', 'bearerClients'],
        message: 'a proxy identity is read at browser sign-in; no bearer carries it',
      })
    }
  })

const providerSchema = z.discriminatedUnion('kind', [
  oidcProviderSchema,
  trustedHeaderProviderSchema,
])

function uniqueBy(
  providers: readonly { id: string; issuer?: string; authenticator?: string }[],
  key: 'id' | 'issuer' | 'authenticator',
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>()
  providers.forEach((provider, index) => {
    const value = provider[key]
    if (value === undefined) return
    if (seen.has(value)) {
      ctx.addIssue({
        code: 'custom',
        path: ['providers', index, key],
        message: `two providers share the ${key} ${value}`,
      })
    }
    seen.add(value)
  })
}

export const signInConfigSchema = z
  .object({ providers: z.array(providerSchema).default([]) })
  .strict()
  .superRefine(({ providers }, ctx) => {
    uniqueBy(providers, 'id', ctx)
    uniqueBy(providers, 'issuer', ctx)
    // Two providers resolving one subject to one account would let the looser
    // one's rules admit whom the stricter one refused.
    uniqueBy(
      providers.map((provider) => ({
        id: provider.id,
        authenticator: providerAuthenticator(provider),
      })),
      'authenticator',
      ctx,
    )
  })

type SignInConfig = z.infer<typeof signInConfigSchema>
export type SignInProvider = SignInConfig['providers'][number]
export type OidcProvider = Extract<SignInProvider, { kind: 'oidc' }>
export type TrustedHeaderProvider = Extract<SignInProvider, { kind: 'trusted-header' }>
export type ProviderAdmission = z.infer<typeof providerAdmissionSchema>

/**
 * The authenticator an account binding names for this provider. It is keyed
 * on the ISSUER, because OIDC Core 1.0 section 2 makes `sub` unique only
 * within its issuer: keyed on the operator's id, a provider re-pointed at
 * another issuer would resolve that issuer's subjects to the first one's
 * accounts.
 *
 * A digest of the issuer rather than the issuer itself: the same issuer
 * always yields the same key, while the name travels through auth decisions
 * and rows without spelling out the provider's URL.
 */
export function providerAuthenticator(
  provider: Pick<OidcProvider, 'issuer'> | TrustedHeaderProvider,
): string {
  if (!('issuer' in provider)) {
    // A signed assertion names its issuer, and `sub` is unique within it. A
    // bare header names nothing, so its subjects are the provider id's; the
    // `id:` prefix keeps that from colliding with an issuer URL.
    const source = provider.assertion?.issuer ?? `id:${provider.id}`
    return `proxy:${digest(source)}`
  }
  return `oidc:${digest(provider.issuer)}`
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}
