import { SINGLE_PERSON_NAMESPACE } from '@kamiazya/whiteboard-model'
import { resolveWorkspaceHandle } from '@kamiazya/whiteboard-ports'
import type { Context } from 'hono'
import { workspaceRegistry } from './store/document-store.js'
import { validateWorkspaceId, validationErrorBody } from './validators.js'

/**
 * The namespace of a caller who has none of their own: a server-mode grant
 * that names no user of this tenant. No row's namespace can equal it (the
 * empty string is no handle), so a bare segment from such a caller matches
 * nothing, while a canonical id still resolves.
 */
export const NO_NAMESPACE = ''

/**
 * Whose namespace a bare segment means for this request (ADR-0053): the
 * signed-in user's handle on server mode, which its auth middleware records
 * before any handle is resolved. A request nothing recorded one for is a
 * single-person keeper's — the local daemon, stdio — whose one namespace is
 * `me`.
 */
const callerNamespaces = new WeakMap<Request, string>()

export function rememberCallerNamespace(c: Context, namespace: string): void {
  callerNamespaces.set(c.req.raw, namespace)
}

export function callerNamespaceOf(c: Context): string {
  return callerNamespaces.get(c.req.raw) ?? SINGLE_PERSON_NAMESPACE
}

/**
 * ADR-0019: an address carries a HANDLE, which is either a workspace's
 * `segment` or its canonical id. This is the daemon's one place that turns
 * one into the other, so no route, tool or socket can answer differently —
 * `resolveWorkspaceHandle` in ports fixes the precedence, and this fixes
 * which registry it reads.
 *
 * A segment is unique per namespace (ADR-0053), so a bare one is looked up in
 * `callerNamespace` alone: resolving it across the registry would answer
 * with whoever else holds that segment.
 *
 * TOTAL by design: a handle matching nothing passes through unchanged, so
 * every existing refusal keeps the status, body and wording it already had,
 * and names what the caller actually typed rather than something derived.
 */
export async function resolveWorkspaceHandleToId(
  handle: string,
  callerNamespace: string = SINGLE_PERSON_NAMESPACE,
): Promise<string> {
  const entries = await workspaceRegistry().listWorkspaces()
  return resolveWorkspaceHandle(entries, handle, callerNamespace)?.workspaceId ?? handle
}

/**
 * Per-REQUEST memo, keyed on the underlying `Request`, so a handle is
 * resolved once no matter how many composed routers and helpers read it.
 * The daemon has no single middleware to hang this on: its handlers reach
 * module-level store state rather than one injected `deps`, and two of the
 * three address families are hand-parsed out of a wildcard path rather than
 * bound as a route param. Resolving twice would be worse than untidy — the
 * second answer keys write locks, doc caches and connection registries, and
 * two independent resolutions of the same handle are two chances to disagree.
 */
const memo = new WeakMap<Request, Map<string, string>>()

export async function workspaceIdFromHandle(c: Context, handle: string): Promise<string> {
  let perRequest = memo.get(c.req.raw)
  if (perRequest === undefined) {
    perRequest = new Map()
    memo.set(c.req.raw, perRequest)
  }
  const hit = perRequest.get(handle)
  if (hit !== undefined) return hit
  const workspaceId = await resolveWorkspaceHandleToId(handle, callerNamespaceOf(c))
  perRequest.set(handle, workspaceId)
  return workspaceId
}

/**
 * The 400 for an address no workspace can have, or null when the handle is
 * well-formed. A malformed address is the caller's mistake, so it is refused
 * before any try block that maps store failures onto 500s, and a validator
 * failing for another reason is a fault and rethrown.
 *
 * A route that must resolve the handle later — inside its own try, after
 * other checks — calls this half alone; every other route calls
 * `parseWorkspaceHandle`.
 *
 * The body is `{ error, message }`, the family every route here speaks except
 * the page-facing `workspace-document` surface (Problem Details) and
 * replica-key's typed `MembershipRefusal`; those validate for themselves.
 */
export function refuseMalformedHandle(c: Context, handle: string): Response | null {
  try {
    validateWorkspaceId(handle)
    return null
  } catch (err) {
    const body = validationErrorBody(err)
    if (body === null) throw err
    return c.json(body, 400)
  }
}

/**
 * A route's prologue as one decision: the canonical workspace id for the
 * handle in the address, or the refusal to return as the response. Refusal is
 * a value here, as it is in `people-administration`, so the caller keeps its
 * own `return` and no handler catches to learn what the address meant.
 */
export async function parseWorkspaceHandle(
  c: Context,
  handle: string,
): Promise<{ readonly workspaceId: string } | { readonly refusal: Response }> {
  const refusal = refuseMalformedHandle(c, handle)
  if (refusal !== null) return { refusal }
  return { workspaceId: await workspaceIdFromHandle(c, handle) }
}
