import type { SignInRefusal } from '@kamiazya/whiteboard-daemon-client/api-contracts/sign-in'

/**
 * What the sign-in screen says for each reason the keeper sends a browser
 * back with. Keyed by the contract's own enum, so a reason added there is a
 * type error here until it has words.
 */
export const SIGN_IN_REFUSAL_COPY = {
  sign_in_attempt_unknown:
    'That sign-in expired or was started in another browser. Please try again.',
  provider_refused: 'The sign-in provider did not confirm who you are. Please try again.',
  provider_unreachable: 'The sign-in provider could not be reached. Please try again later.',
  unknown_provider: 'That sign-in provider is not configured on this server.',
  invitation_unusable: 'That invitation has been used or has expired. Ask for a new one.',
  no_subject: 'The sign-in provider did not say who you are.',
  deactivated: 'Your account on this server has been deactivated. Ask an administrator.',
  email_unverified: 'Your email address is not verified with the sign-in provider.',
  email_domain_not_allowed: 'Your email domain is not allowed on this server.',
  hosted_domain_not_allowed: 'Your organisation is not allowed on this server.',
  claim_not_satisfied: 'Your account is not in a group this server allows.',
  not_invited: 'You need an invitation to use this server. Ask someone who uses it to invite you.',
  email_invitations_disabled: 'This server does not accept invitations sent to an email address.',
  rule_refused: 'This server does not allow your account.',
} satisfies Record<SignInRefusal, string>

export const GENERIC_SIGN_IN_REFUSAL = 'Sign-in did not complete. Please try again.'
