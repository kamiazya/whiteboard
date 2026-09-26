import { z } from 'zod'

/**
 * ADR-0046/0047: what a server-mode keeper tells the web app it serves about
 * signing in. The keeper answers these under `/auth`, on its own origin, so
 * the session they describe is the host-only cookie the browser already holds.
 */

/** A provider a person can sign in with in a browser. Bearer-only providers
 *  have no browser client and are not listed. */
export const signInProviderSummarySchema = z.object({
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
  'email_invitations_disabled',
  'rule_refused',
  // ADR-0051: re-authenticating needs a session from a provider that can ask
  // the person to sign in again, which a reverse proxy cannot.
  'reauthentication_unavailable',
])

export type SignInRefusal = z.infer<typeof signInRefusalSchema>
