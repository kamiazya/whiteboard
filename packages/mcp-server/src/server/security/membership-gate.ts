/**
 * The membership gate both composition roots apply to a workspace-addressed
 * route (ADR-0041 L1; ADR-0046 decision 10 for server mode): which grant
 * authenticated this request, whether it reaches the workspace the route
 * addresses, and the same answer for handlers that decide membership
 * themselves (the workspace list, the SSE transport).
 */
import type { Context } from 'hono'
import { getLogger } from '../log.js'
import { workspaceIdFromHandle } from '../workspace-handle.js'
import type { ResolvedGrant } from './credential-resolver.js'
import type { MemberProfileStore } from './member-profile-store.js'
import { gatedWorkspaceHandle, ruleClaiming } from './route-scope-registry.js'
import {
  membershipRefusal,
  type WorkspaceAccessDecision,
  type WorkspaceAccessOptions,
  workspaceAccess,
} from './workspace-access.js'

const log = getLogger('membership-gate')

/** The one per-request memo of "which grant authenticated this request" —
 *  same idiom as `workspace-handle.ts`'s memo, and for the same reason: a
 *  later handler has no other way to reach the grant. */
const grantMemo = new WeakMap<Request, ResolvedGrant>()

export function rememberGrant(c: Context, grant: ResolvedGrant): void {
  grantMemo.set(c.req.raw, grant)
}

export function grantOf(c: Context): ResolvedGrant | undefined {
  return grantMemo.get(c.req.raw)
}

/**
 * The membership step, for a route the registry marks as workspace-addressed:
 * answers the 403 to send, or `undefined` to admit. An undecodable handle
 * fails CLOSED — the route is gated and carries a handle segment, so treating
 * it like a route with nothing to gate would be the wrong default.
 */
export async function membershipRefusalFor(
  c: Context,
  grant: ResolvedGrant,
  members: MemberProfileStore,
  options: WorkspaceAccessOptions = {},
): Promise<Response | undefined> {
  const gated = gatedWorkspaceHandle(c.req.method, c.req.path)
  if (gated.kind === 'undecodable') {
    log.warning(
      { rule: ruleClaiming(c.req.method, c.req.path) },
      'membership refused: undecodable workspace handle',
    )
    return c.json(membershipRefusal('not_a_member'), 403)
  }
  if (gated.kind !== 'handle') return undefined
  const workspaceId = await workspaceIdFromHandle(c, gated.handle)
  const access = await workspaceAccess(grant, workspaceId, members, options)
  if (access === 'admitted') return undefined
  log.warning(
    { workspaceId, rule: ruleClaiming(c.req.method, c.req.path), reason: access },
    'membership refused',
  )
  return c.json(membershipRefusal(access), 403)
}

/**
 * The membership check for handlers that decide it themselves, bound to the
 * grant this request's middleware already resolved. A request that never
 * reached the middleware has no grant and is answered as needing a person —
 * fail-closed, never "admit by default".
 */
export type WorkspaceAdmit = (c: Context, workspaceId: string) => Promise<WorkspaceAccessDecision>

const NO_GRANT_RESOLVED: ResolvedGrant = { kind: 'pairing', scopes: [] }

export function membershipAdmit(
  members: MemberProfileStore,
  options: WorkspaceAccessOptions = {},
): WorkspaceAdmit {
  return (c, workspaceId) =>
    workspaceAccess(grantOf(c) ?? NO_GRANT_RESOLVED, workspaceId, members, options)
}

/**
 * ADR-0046 decision 10: on a keeper where every workspace is members-only
 * from the start, the person creating one is its first member — otherwise
 * nobody could open what they just made.
 */
export interface FirstMember {
  /** This tenant's user behind the request, or null when there is none to make a member. */
  profileFor(c: Context): Promise<string | null>
  add(workspaceId: string, profileId: string): Promise<void>
}

export function creatorAsFirstMember(members: MemberProfileStore): FirstMember {
  return {
    async profileFor(c) {
      const person = grantOf(c)?.person
      if (person === undefined) return null
      return (await members.profileForBinding(person))?.id ?? null
    },
    add: (workspaceId, profileId) => members.addMember(workspaceId, profileId),
  }
}
