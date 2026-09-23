/**
 * The ONE membership decision (ADR-0041 L1, ADR-0042 d3-d4): a workspace
 * that has EVER had a member admits its document/sync routes only to a
 * session bound to a passkey whose MemberProfile is a CURRENT member of
 * THAT workspace. A workspace that has never had a member keeps origin
 * trust — a personal daemon never needs a passkey. Removing a workspace's
 * last member does NOT revert it to origin trust (user decision
 * 2026-09-21): it stays person-gated, now admitting nobody until a member
 * is added again — see `MemberProfileStore.membersOnly` and the 0030
 * migration.
 *
 * Every membership-gated surface (replica-key today; the route-scope-
 * registry gate, SSE and the WS upgrade later) calls this rather than
 * keeping its own copy. When membership was consulted by replica-key.ts
 * alone, an L1 revoke killed a removed person's bound SESSIONS but left
 * their browser's origin-only pairing token able to read and write every
 * other route — a revoke that bites only the offline replica key is not a
 * revoke.
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
 * daemon's own authority, an `oauth-grant` exists only through the
 * daemon-served consent page, a `macaroon` is minted from the daemon root
 * key, and a `ws-ticket` is mintable only by an `oauth-grant`.
 */
export const OPERATOR_ISSUED_KINDS = [
  'anonymous',
  'daemon-token',
  'oauth-grant',
  'macaroon',
  'ws-ticket',
] as const satisfies readonly ResolvedGrant['kind'][]

export type WorkspaceAccessDecision = 'admitted' | 'requires_person_session' | 'not_a_member'
type MembershipDenial = Exclude<WorkspaceAccessDecision, 'admitted'>

export async function workspaceAccess(
  grant: ResolvedGrant,
  workspaceId: string,
  members: MemberProfileStore,
): Promise<WorkspaceAccessDecision> {
  if ((OPERATOR_ISSUED_KINDS as readonly string[]).includes(grant.kind)) return 'admitted'

  if (!(await members.membersOnly(workspaceId))) return 'admitted'

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
