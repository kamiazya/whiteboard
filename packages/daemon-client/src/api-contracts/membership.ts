import { z } from 'zod'

/**
 * The typed refusal a membership-gated route answers (ADR-0041). A
 * narrowing of `apiErrorBodySchema`'s `{ error, message }` arm, so the
 * existing client error reader (`apiErrorReason`) needs no change to read
 * it. Deliberately free of any node:* import — the browser consumes it
 * directly. `requires_person_session` is what a gated route answers a
 * caller that names no person.
 */
export const membershipRefusalSchema = z.object({
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
export type MembershipRefusal = z.infer<typeof membershipRefusalSchema>
export type MembershipRefusalCode = MembershipRefusal['error']
