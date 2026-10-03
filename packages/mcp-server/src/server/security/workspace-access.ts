/**
 * The ONE membership decision (ADR-0041 L1, ADR-0042 d3-d4, ADR-0046
 * decision 10): every workspace is members-only, including one that has never
 * had a member. A document or sync route admits only a session bound to a
 * person whose MemberProfile is a CURRENT member of THAT workspace; a
 * workspace nobody has joined admits nobody until someone is added, so none
 * is open because it was forgotten. Removing a workspace's last member does
 * not reopen it either (user decision 2026-09-21).
 *
 * The server-mode `/api` middleware, the `/mcp` tool-call gate and the
 * handlers that decide membership themselves (the workspace list, the SSE
 * transport) all call this rather than keeping a copy: a revoke that bit only
 * the offline replica key would leave a removed person's other credentials
 * reading and writing every other route. The local daemon never mounts it —
 * it has one person and no membership (ADR-0050 decision 3).
 */
import type { MembershipRefusal } from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
import type { ResolvedGrant } from './credential-resolver.js'
import type { MemberProfileStore } from './member-profile-store.js'

/**
 * These grant kinds could never name a PERSON (ADR-0041's L1 subject), so
 * gating them on membership would be a permanent lockout the moment a
 * workspace gains its first member — the "person-required everywhere"
 * option the ADR-0041 addendum lists as NOT chosen. Each is already
 * operator-consented at mint time: `daemon-token`/`anonymous` hold the
 * daemon's own authority, and a `macaroon` is minted from the daemon root
 * key.
 */
export const OPERATOR_ISSUED_KINDS = [
  'anonymous',
  'daemon-token',
  'macaroon',
] as const satisfies readonly ResolvedGrant['kind'][]

export type WorkspaceAccessDecision = 'admitted' | 'requires_person_session' | 'not_a_member'
export type MembershipDenial = Exclude<WorkspaceAccessDecision, 'admitted'>

export async function workspaceAccess(
  grant: ResolvedGrant,
  workspaceId: string,
  members: MemberProfileStore,
): Promise<WorkspaceAccessDecision> {
  if ((OPERATOR_ISSUED_KINDS as readonly string[]).includes(grant.kind)) return 'admitted'

  if (grant.person === undefined) return 'requires_person_session'

  const profile = await members.profileForBinding(grant.person)
  if (profile === null) return 'not_a_member'

  const membership = await members.isWorkspaceMember(workspaceId, profile.id)
  return membership === 'not-a-member' ? 'not_a_member' : 'admitted'
}

const MEMBERSHIP_REFUSAL_MESSAGE: Record<MembershipDenial, string> = {
  requires_person_session: 'this session is not signed in as a member',
  not_a_member: 'no such member in this workspace',
}

export function membershipRefusal(access: MembershipDenial): MembershipRefusal {
  return { error: access, message: MEMBERSHIP_REFUSAL_MESSAGE[access] }
}
