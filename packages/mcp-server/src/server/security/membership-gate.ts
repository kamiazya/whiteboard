/**
 * The membership gate both composition roots apply to a workspace-addressed
 * route (ADR-0041 L1; ADR-0046 decision 10 for server mode): which grant
 * authenticated this request, whether it reaches the workspace the route
 * addresses, and the same answer for handlers that decide membership
 * themselves (the workspace list, the SSE transport).
 */
import type { Context, Next } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { getLogger } from '../log.js'
import { runWithWriteAdmission } from '../store/workspace-lock.js'
import {
  NO_NAMESPACE,
  rememberCallerNamespace,
  workspaceIdFromHandle,
} from '../workspace-handle.js'
import { type AuthScope, hasRequiredScopes } from './auth-strategy.js'
import type { ResolvedGrant } from './credential-resolver.js'
import type { AuthenticatorBinding, MemberProfileStore } from './member-profile-store.js'
import { gatedWorkspaceHandle, ruleClaiming } from './route-scope-registry.js'
import {
  membershipRefusal,
  OPERATOR_ISSUED_KINDS,
  type WorkspaceAccessDecision,
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

function grantOf(c: Context): ResolvedGrant | undefined {
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
  const access = await workspaceAccess(grant, workspaceId, members)
  if (access === 'admitted') return undefined
  log.warning(
    { workspaceId, rule: ruleClaiming(c.req.method, c.req.path), reason: access },
    'membership refused',
  )
  return c.json(membershipRefusal(access), 403)
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Runs an admitted request so its writes check membership again as they are
 * made. The gate above judged the request when it arrived, before its body;
 * a person removed (or deactivated) while that body was still arriving must
 * not have the write land. The check is one indexed read on each workspace
 * write lock the request enters for the workspace it addresses, and only
 * while the request is being answered: work it schedules for later (a
 * checkpoint) writes what was already accepted.
 *
 * Only a person's grant is re-checked — an operator-issued one is admitted
 * by kind, which no removal changes.
 */
export async function whileStillAdmitted(
  c: Context,
  grant: ResolvedGrant,
  members: MemberProfileStore,
  next: Next,
): Promise<void> {
  if (READS.has(c.req.method.toUpperCase())) return next()
  if ((OPERATOR_ISSUED_KINDS as readonly string[]).includes(grant.kind)) return next()
  const gated = gatedWorkspaceHandle(c.req.method, c.req.path)
  if (gated.kind !== 'handle' || grant.person === undefined) return next()
  const userId = (await members.profileForBinding(grant.person))?.id
  if (userId === undefined) return next()
  const workspaceId = await workspaceIdFromHandle(c, gated.handle)
  const admit = async (writing: string) => {
    if (writing !== workspaceId) return
    if (await members.holdsAccess(workspaceId, userId)) return
    log.warning(
      { workspaceId, rule: ruleClaiming(c.req.method, c.req.path), reason: 'not_a_member' },
      'write refused: membership ended while the request was in flight',
    )
    throw new HTTPException(403, { res: c.json(membershipRefusal('not_a_member'), 403) })
  }
  await runWithWriteAdmission(admit, next)
}

/**
 * The membership check for handlers that decide it themselves, bound to the
 * grant this request's middleware already resolved. A request that never
 * reached the middleware has no grant and is answered as needing a person —
 * fail-closed, never "admit by default".
 */
export type WorkspaceAdmit = (c: Context, workspaceId: string) => Promise<WorkspaceAccessDecision>

const NO_GRANT_RESOLVED: ResolvedGrant = { kind: 'external-bearer', scopes: [] }

export function membershipAdmit(members: MemberProfileStore): WorkspaceAdmit {
  return (c, workspaceId) => workspaceAccess(grantOf(c) ?? NO_GRANT_RESOLVED, workspaceId, members)
}

/**
 * Whether this request's person owns the workspace (ADR-0049) — what an
 * owner-only change asks before it runs. Absent where there are no people to
 * tell apart.
 */
export type WorkspaceOwnership = (c: Context, workspaceId: string) => Promise<boolean>

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

/**
 * Whose namespace a bare segment means for this grant (ADR-0053): its user's
 * handle, or a namespace nobody holds when the grant names no user of this
 * tenant — an operator-issued grant, or a bearer with no user here. Those
 * still reach a workspace by its canonical id.
 */
export async function namespaceOfGrant(
  grant: ResolvedGrant,
  members: MemberProfileStore,
): Promise<string> {
  if (grant.person === undefined) return NO_NAMESPACE
  return (await members.profileForBinding(grant.person))?.handle ?? NO_NAMESPACE
}

/**
 * Server mode's record of who a request is, for everything after its auth
 * middleware: the grant, and whose namespace a bare segment means. Recorded
 * before the gate, since resolving the address it checks reads the latter.
 */
export async function rememberCaller(
  c: Context,
  grant: ResolvedGrant,
  members: MemberProfileStore,
): Promise<void> {
  rememberGrant(c, grant)
  rememberCallerNamespace(c, await namespaceOfGrant(grant, members))
}

/** The grant the middleware resolved for this request, if it reached one. */
export function callerGrant(c: Context): ResolvedGrant | undefined {
  return grantOf(c)
}

/**
 * Whether this request's grant holds every one of `scopes` — for a route the
 * gate admitted on a narrower scope, deciding a part of the request that
 * needs more. A request whose middleware resolved no grant holds none.
 */
export function callerHolds(c: Context, scopes: readonly AuthScope[]): boolean {
  return hasRequiredScopes(grantOf(c)?.scopes ?? [], scopes)
}

/** The person the middleware authenticated this request as, if any. */
function callerPerson(c: Context): AuthenticatorBinding | undefined {
  return grantOf(c)?.person
}

/** This tenant's user behind the request the middleware authenticated, or
 *  null when the grant names no person with a user here. */
export async function callerUserId(
  c: Context,
  members: MemberProfileStore,
): Promise<string | null> {
  const person = callerPerson(c)
  if (person === undefined) return null
  return (await members.profileForBinding(person))?.id ?? null
}

/**
 * The name a row a person writes (a saved version, a promote checkpoint)
 * records, on a keeper with people to tell apart: the caller's own profile
 * name, or null when the grant names no user here. Absent where there is one
 * person (the local daemon), whose rows keep today's self-report.
 */
export type CallerName = (c: Context) => Promise<string | null>

export function callerDisplayName(members: MemberProfileStore): CallerName {
  return async (c) => {
    const person = callerPerson(c)
    if (person === undefined) return null
    return (await members.profileForBinding(person))?.displayName ?? null
  }
}

export function creatorAsFirstMember(members: MemberProfileStore): FirstMember {
  return {
    profileFor: (c) => callerUserId(c, members),
    add: (workspaceId, profileId) => members.addMember(workspaceId, profileId),
  }
}
