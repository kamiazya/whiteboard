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
    'workspace_not_found',
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

/**
 * The one refusal a daemon route answers, with 404, for a workspace nothing
 * answers to — `/api/v1`'s own code, so a client holds one reading of "gone"
 * however it reached the workspace. `handle` is what the caller typed.
 *
 * Built here beside the code's declaration so no route words it for itself;
 * the literal `error` lets a route that types its refusal as a
 * `MembershipRefusal` return it unchanged.
 */
export function workspaceNotFoundRefusal(handle: string): {
  error: 'workspace_not_found'
  message: string
} {
  return {
    error: 'workspace_not_found',
    message: `Workspace "${handle}" not found`,
  } satisfies MembershipRefusal
}
