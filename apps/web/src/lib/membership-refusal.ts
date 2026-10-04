/**
 * What the daemon's membership gate looks like from this browser
 * (ADR-0041/0042): a keeper that knows who is asking and says this person
 * is not a member of the workspace. Only server mode has more than one
 * person, so only there can this arrive.
 *
 * `membershipRefusal` reads the refusal by CODE, through
 * `membershipRefusalSchema`, never by matching the sentence — the sentence
 * is free to change (and does, per refusal) without breaking this branch.
 */
import { membershipRefusalSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import { DaemonApiError } from './daemon-api-client.js'

/** The membership refusal code this page acts on — every other code
 *  (requires_person_session, workspace_not_found, …) is left to the generic
 *  `loadError` path, unclassified. */
export type MembershipRefusalAction = 'not_a_member'

/** A refusal with the workspace it pertains to — the shape the controller
 *  reports and the page state renders. Named `*State` (rather than the bare
 *  `MembershipRefusal`) because daemon-client's own
 *  `api-contracts/membership.ts` already exports a `MembershipRefusal` for
 *  the WIRE shape (`{error, message}`) — same name, unrelated shape, and a
 *  future import of both under one local name would silently pick either. */
export interface MembershipRefusalState {
  code: MembershipRefusalAction
  workspaceId: string
}

export function membershipRefusal(err: unknown): MembershipRefusalAction | null {
  if (!(err instanceof DaemonApiError)) return null
  const parsed = membershipRefusalSchema.safeParse(err.body)
  if (!parsed.success) return null
  return parsed.data.error === 'not_a_member' ? parsed.data.error : null
}
