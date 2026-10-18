import { z } from 'zod'

// ADR-0046/0047: what a server-mode keeper tells the web app it serves about
// signing in. The keeper answers these under `/auth`, on its own origin, so
// the session they describe is the host-only cookie the browser already holds.

/** A provider a person can sign in with in a browser. Bearer-only providers
 *  have no browser client and are not listed. */
const signInProviderSummarySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
})

export const signInProvidersResponseSchema = z.object({
  providers: z.array(signInProviderSummarySchema),
})

export type SignInProvidersResponse = z.infer<typeof signInProvidersResponseSchema>

export const signInSessionResponseSchema = z.discriminatedUnion('signedIn', [
  z.object({ signedIn: z.literal(false) }),
  z.object({
    signedIn: z.literal(true),
    // `userId` finds this person in a people list; `administrator` is
    // whether they administer the server (ADR-0049), which is what the web
    // app shows its people screen for.
    user: z.object({
      userId: z.string().min(1),
      displayName: z.string(),
      administrator: z.boolean(),
    }),
  }),
])

export type SignInSessionResponse = z.infer<typeof signInSessionResponseSchema>

/**
 * The invite page's Accept: a same-origin POST, because a link — on another
 * site, inside a document here, in a mail client — is a navigation, and a
 * navigation must never be what joins a person to a workspace. The token
 * travels in the body, so it stays out of a URL a proxy logs.
 */
export const acceptInvitationRequestSchema = z
  .object({
    invitation: z.string(),
    returnTo: z.string().optional(),
  })
  .strict()

export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>

/** Where the browser goes next: the provider, or the sign-in screen with a refusal. */
export const acceptInvitationResponseSchema = z.object({
  location: z.string().min(1),
})

export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>

/**
 * Why a sign-in came back refused. The keeper's callback sends the browser to
 * the sign-in screen with one of these as `?error=`, and the screen explains
 * it; an unknown value is shown as a generic failure.
 */
export const signInRefusalSchema = z.enum([
  'sign_in_attempt_unknown',
  'provider_refused',
  'provider_unreachable',
  'unknown_provider',
  'invitation_unusable',
  'no_subject',
  'deactivated',
  'email_unverified',
  'email_domain_not_allowed',
  'hosted_domain_not_allowed',
  'claim_not_satisfied',
  'not_invited',
  'rule_refused',
  // ADR-0051: re-authenticating needs a session from a provider that can ask
  // the person to sign in again, which a reverse proxy cannot.
  'reauthentication_unavailable',
])

export type SignInRefusal = z.infer<typeof signInRefusalSchema>
