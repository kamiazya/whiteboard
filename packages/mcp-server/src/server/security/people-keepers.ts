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
import { callerGrant, callerUserId, type OwnerChangeRefusal } from './membership-gate.js'

export interface WorkspacePeopleKeeper {
  /** Whether the person behind this request owns `workspaceId` — enough to
   *  READ what only owners see. */
  owns(c: Context, workspaceId: string): Promise<boolean>
  /** Whether this request may CHANGE the people of `workspaceId`: null when
   *  it may, else why not. */
  mayChange(c: Context, workspaceId: string): Promise<OwnerChangeRefusal | null>
  /** Who is acting, for the invitations they create; null for nobody here. */
  actingUserId(c: Context): Promise<string | null>
  /** Absent where nothing could redeem an invitation link. */
  readonly invitations?: { readonly store: InvitationStore; readonly origin: string }
}

// Whether the person behind this request is an owner of `workspaceId`.
async function callerOwns(
  c: Context,
  members: MemberProfileStore,
  workspaceId: string,
): Promise<boolean> {
  const caller = await callerUserId(c, members)
  if (caller === null) return false
  return (await members.membershipRole(workspaceId, caller)) === 'owner'
}

/**
 * What every owner-only change on server mode asks — a workspace's people and
 * its segment alike: an owner, acting through a browser sign-in. A bearer has
 * no browser behind it, however it is scoped, so it never administers a
 * workspace, exactly as it never administers the tenant
 * (`people-administration.ts`). A non-owner is told so first, as there.
 */
export async function ownerChangeRefusal(
  c: Context,
  members: MemberProfileStore,
  workspaceId: string,
): Promise<OwnerChangeRefusal | null> {
  if (!(await callerOwns(c, members, workspaceId))) return 'not_an_owner'
  return callerGrant(c)?.kind === 'signed-in' ? null : 'sign_in_required'
}

export function serverModePeopleKeeper(deps: {
  readonly members: MemberProfileStore
  readonly invitations: InvitationStore
  readonly origin: string
}): WorkspacePeopleKeeper {
  return {
    owns: (c, workspaceId) => callerOwns(c, deps.members, workspaceId),
    mayChange: (c, workspaceId) => ownerChangeRefusal(c, deps.members, workspaceId),
    actingUserId: (c) => callerUserId(c, deps.members),
    invitations: { store: deps.invitations, origin: deps.origin },
  }
}
