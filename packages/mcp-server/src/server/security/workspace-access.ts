/**
 * The ONE membership decision (ADR-0041 L1, ADR-0042 d3-d4, user decision
 * 2026-09-21): a workspace that has one or more members admits its
 * document/sync routes only to a session bound to a passkey whose
 * MemberProfile is a member of THAT workspace. A workspace with zero
 * members keeps origin trust — a personal daemon never needs a passkey.
 *
 * Before this, membership was consulted by replica-key.ts alone, which
 * meant an L1 revoke (`revokeL1Membership`) killed a removed person's
 * bound SESSIONS but left their browser's origin-only pairing token able
 * to read and write every other route: a revoke that bites only the
 * offline replica key is not a revoke.
 *
 * `workspaceAccess` is meant to be the ONLY place that answers this
 * question — replica-key.ts and every future membership-gated surface
 * (the route-scope-registry gate, SSE, the WS upgrade) call this rather
 * than keep their own copy, so no two surfaces can classify one
 * (grant, workspace) pair differently.
 */
import type {
  MembershipRefusal,
  MembershipRefusalCode,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/membership'
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

type MembershipReader = Pick<
  MemberProfileStore,
  'listMembers' | 'profileForCredential' | 'isWorkspaceMember'
>

export async function workspaceAccess(
  grant: ResolvedGrant,
  workspaceId: string,
  members: MembershipReader,
): Promise<WorkspaceAccessDecision> {
  if ((OPERATOR_ISSUED_KINDS as readonly string[]).includes(grant.kind)) return 'admitted'

  // ponytail: one listMembers (1+N rows) per gated request — a count query
  // is the upgrade path if this shows up in a profile.
  const memberList = await members.listMembers(workspaceId)
  if (memberList.length === 0) return 'admitted'

  if (grant.passkey === undefined) return 'requires_person_session'

  const profile = await members.profileForCredential(
    grant.passkey.origin,
    grant.passkey.credentialId,
  )
  if (profile === null) return 'not_a_member'

  const membership = await members.isWorkspaceMember(workspaceId, profile.id)
  return membership === 'not-a-member' ? 'not_a_member' : 'admitted'
}

const MEMBERSHIP_REFUSAL_MESSAGE: Record<
  Extract<WorkspaceAccessDecision, 'requires_person_session' | 'not_a_member'>,
  string
> = {
  requires_person_session: 'this session is not signed in as a member',
  not_a_member: 'no such member in this workspace',
}

export function membershipRefusal(
  access: Extract<WorkspaceAccessDecision, 'requires_person_session' | 'not_a_member'>,
): MembershipRefusal {
  return {
    error: access as MembershipRefusalCode,
    message: MEMBERSHIP_REFUSAL_MESSAGE[access],
  }
}
