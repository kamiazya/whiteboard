import type { ResolvedGrant } from './credential-resolver.js'
import type { MemberProfileStore } from './member-profile-store.js'
import { OPERATOR_ISSUED_KINDS } from './workspace-access.js'

/**
 * What a write admitted to the workspace `workspaceOf` names must still pass as it enters that
 * workspace's write lock: the person behind the grant is still a member. The
 * gate judged the call when it arrived; this is the same question asked right
 * before the change, for a person removed (or deactivated) while the write
 * waited — on its body, on another writer, or on the ops before it in a batch.
 *
 * `null` when there is nothing to re-check: an operator-issued grant is
 * admitted by kind, which no removal changes, and a grant naming no person
 * with a profile was never admitted as a member; both are answered before
 * `workspaceOf` is asked, which may resolve a handle. `refuse` builds the
 * surface's own refusal, thrown out of the lock before anything is written.
 */
export async function membershipRecheck(
  grant: ResolvedGrant,
  members: MemberProfileStore,
  workspaceOf: () => Promise<string | null>,
  refuse: (workspaceId: string) => Error,
): Promise<((writing: string) => Promise<void>) | null> {
  if ((OPERATOR_ISSUED_KINDS as readonly string[]).includes(grant.kind)) return null
  const person = grant.person
  if (person === undefined) return null
  const workspaceId = await workspaceOf()
  if (workspaceId === null) return null
  const userId = (await members.profileForBinding(person))?.id
  if (userId === undefined) return null
  return async (writing) => {
    if (writing !== workspaceId) return
    if (await members.holdsAccess(workspaceId, userId)) return
    throw refuse(workspaceId)
  }
}
