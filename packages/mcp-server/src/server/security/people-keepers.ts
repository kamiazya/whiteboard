/**
 * ADR-0049: who may change a workspace's people, and how a person arrives.
 * `routes/workspace-people.ts` is the API; this is the keeper's policy.
 *
 * Server mode is the only keeper with people: a member whose role is `owner`
 * manages them, and a person arrives through an invitation link, since a
 * sign-in is how anyone reaches the keeper. The local daemon has one person,
 * the owner who alone can open its socket (ADR-0050 decision 3), so there is
 * nobody for it to manage.
 */
import type { Context } from 'hono'
import type { InvitationStore } from './invitation-store.js'
import type { MemberProfileStore } from './member-profile-store.js'
import { callerUserId } from './membership-gate.js'

export interface WorkspacePeopleKeeper {
  /** Whether this request may change the people of `workspaceId`. */
  canManage(c: Context, workspaceId: string): Promise<boolean>
  /** Who is acting, for the invitations they create; null for nobody here. */
  actingUserId(c: Context): Promise<string | null>
  /** Absent where nothing could redeem an invitation link. */
  readonly invitations?: { readonly store: InvitationStore; readonly origin: string }
}

export function serverModePeopleKeeper(deps: {
  readonly members: MemberProfileStore
  readonly invitations: InvitationStore
  readonly origin: string
}): WorkspacePeopleKeeper {
  return {
    async canManage(c, workspaceId) {
      const caller = await callerUserId(c, deps.members)
      if (caller === null) return false
      return (await deps.members.membershipRole(workspaceId, caller)) === 'owner'
    },
    actingUserId: (c) => callerUserId(c, deps.members),
    invitations: { store: deps.invitations, origin: deps.origin },
  }
}
