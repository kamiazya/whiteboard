/**
 * ADR-0049 decision 5: one people API for both keepers, which differ only in
 * who may change a workspace's people and in what a person is. This is where
 * they differ; `routes/workspace-people.ts` is everything they share.
 *
 * - **Server mode**: a member whose role is `owner`; a person arrives through
 *   an invitation link, since a sign-in is how anyone reaches the keeper.
 * - **Local daemon**: the machine's owner owns every workspace, and a caller
 *   speaks for them when its credential carries `runtime:admin` — the bar the
 *   daemon's other administrative routes sit at. There is no sign-in, so no
 *   invitation; a person is a pinned passkey, added through `membership.ts`,
 *   and removing one ends the sessions bound to their passkeys (ADR-0042).
 *
 * The local half is the part ADR-0050 replaces: once the hosted page reaches
 * the daemon through the extension, the machine's owner is whoever holds the
 * socket, and passkey-bound sessions are gone.
 */
import type { Context } from 'hono'
import type { InvitationStore } from './invitation-store.js'
import type { MemberProfileStore } from './member-profile-store.js'
import { callerScopes, callerUserId } from './membership-gate.js'
import type { PairingTokenStore } from './pairing-session.js'

export interface WorkspacePeopleKeeper {
  /** Whether this request may change the people of `workspaceId`. */
  canManage(c: Context, workspaceId: string): Promise<boolean>
  /** Who is acting, for the invitations they create; null for nobody here. */
  actingUserId(c: Context): Promise<string | null>
  /** What removing a person from a workspace also ends, if anything. */
  afterRemove?(profileId: string): Promise<void>
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

export function localDaemonPeopleKeeper(deps: {
  readonly members: MemberProfileStore
  readonly tokens: PairingTokenStore
}): WorkspacePeopleKeeper {
  return {
    canManage: async (c) => callerScopes(c).includes('runtime:admin'),
    actingUserId: (c) => callerUserId(c, deps.members),
    async afterRemove(profileId) {
      deps.tokens.revokeBoundTo(await deps.members.passkeysOf(profileId))
    },
  }
}
