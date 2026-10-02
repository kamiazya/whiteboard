import type { MemberProfileStore } from '../server/security/member-profile-store.js'
import type { AnyRefusal } from '../server/security/people-administration.js'
import type { NamedUser } from './operator-json.js'

export type NamedUserLookup =
  | { kind: 'found'; user: NamedUser }
  | { kind: 'unknown-user' | 'ambiguous-user'; users: NamedUser[] }

/**
 * The user an operator named, by id or by exact display name. A name that
 * matches nobody, or more than one, is answered with the candidates rather
 * than a guess.
 */
export async function findNamedUser(
  members: Pick<MemberProfileStore, 'listUsers'>,
  user: string,
): Promise<NamedUserLookup> {
  const users = (await members.listUsers()).map(({ id, displayName }) => ({ id, displayName }))
  const byId = users.filter((u) => u.id === user)
  const matches = byId.length > 0 ? byId : users.filter((u) => u.displayName === user)
  const [only] = matches
  if (only === undefined) return { kind: 'unknown-user', users }
  if (matches.length > 1) return { kind: 'ambiguous-user', users: matches }
  return { kind: 'found', user: only }
}

/**
 * The operator's outcome for a refusal from the people operation. The user was
 * found a moment ago, so `unknown_user` here means they were deleted in
 * between. The operator is nobody's user, so a refusal about acting on oneself
 * cannot be reached from the command line.
 */
export function operatorRefusal(refusal: AnyRefusal): { kind: 'unknown-user'; users: [] } {
  if (refusal.reason !== 'unknown_user') {
    throw new Error(`the operator cannot be refused as acting on themselves: ${refusal.reason}`)
  }
  return { kind: 'unknown-user', users: [] }
}
