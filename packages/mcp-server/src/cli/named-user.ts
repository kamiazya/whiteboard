import type { MemberProfileStore } from '../server/security/member-profile-store.js'

export interface NamedUser {
  id: string
  displayName: string
}

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
