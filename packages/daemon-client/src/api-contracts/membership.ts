import { z } from 'zod'
import { pinnedCredentialSummarySchema } from './pairing.js'

/**
 * Membership wire contract, shared between the daemon's member routes and
 * the browser settings surface (ADR-0041). A MEMBER is a PERSON, identified
 * by the passkey credentials the daemon has pinned — never by a paired
 * origin, and never by the credential's public key, which stays on the
 * daemon (same rule as pinnedCredentialSummarySchema). Deliberately free of
 * any node:* import — the browser consumes these schemas directly.
 */

export const memberProfileSummarySchema = z
  .object({
    profileId: z.string().min(1),
    displayName: z.string().min(1),
    credentials: z.array(pinnedCredentialSummarySchema.pick({ credentialId: true, origin: true })),
    createdAt: z.string(),
  })
  .strict()
export type MemberProfileSummary = z.infer<typeof memberProfileSummarySchema>

export const listMembersResponseSchema = z
  .object({ members: z.array(memberProfileSummarySchema) })
  .strict()
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>

/**
 * An administrator names a pinned passkey credential by (origin,
 * credentialId) — the pin store's own key (webauthn-credential-store.ts) —
 * because a credentialId can recur across origins and naming half the key
 * would let a pin from one origin vouch for another. The daemon mints a
 * MemberProfile if that credential has none yet, else reuses it, and adds
 * the membership row.
 */
export const addMemberRequestSchema = z
  .object({
    credentialId: z.string().min(1),
    origin: z.string().min(1),
    displayName: z.string().min(1).max(120),
  })
  .strict()
export type AddMemberRequest = z.infer<typeof addMemberRequestSchema>

export const removeMemberResponseSchema = z
  .object({
    removed: z.literal(true),
    // The synchronous kill of that person's live passkey-bound sessions —
    // removal is L1 revocation (ADR-0041 decision 3), not a lazy expiry.
    sessionsEnded: z.number().int().nonnegative(),
  })
  .strict()
export type RemoveMemberResponse = z.infer<typeof removeMemberResponseSchema>

/**
 * The typed refusal every membership route answers. A strict narrowing of
 * `apiErrorBodySchema`'s `{ error, message }` arm, so the existing client
 * error reader (`apiErrorReason`) needs no change to read it.
 * `requires_person_session` is what a route answers a paired session that
 * has not yet been bound to a passkey via a session assertion.
 */
export const membershipRefusalSchema = z
  .object({
    error: z.enum([
      'not_a_member',
      'unknown_credential',
      'unknown_profile',
      'unknown_workspace',
      'invalid_workspace_id',
      'requires_person_session',
      // The replica-key route reuses this refusal shape rather than
      // inventing a second one for a family this small — see
      // api-contracts/replica-key.ts.
      'replica_not_allowed',
    ]),
    message: z.string().min(1),
  })
  .strict()
export type MembershipRefusal = z.infer<typeof membershipRefusalSchema>
export type MembershipRefusalCode = MembershipRefusal['error']
