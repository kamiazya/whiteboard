import { resolveWorkspaceHandle } from '@kamiazya/whiteboard-ports'
import type { Context } from 'hono'
import { workspaceRegistry } from './store/document-store.js'

/**
 * ADR-0019: an address carries a HANDLE, which is either a workspace's
 * per-keeper `segment` or its canonical id. This is the daemon's one place
 * that turns one into the other, so no route, tool or socket can answer
 * differently — `resolveWorkspaceHandle` in ports fixes the precedence, and
 * this fixes which registry it reads.
 *
 * TOTAL by design: a handle matching nothing passes through unchanged, so
 * every existing refusal keeps the status, body and wording it already had,
 * and names what the caller actually typed rather than something derived.
 */
export async function resolveWorkspaceHandleToId(handle: string): Promise<string> {
  const entries = await workspaceRegistry().listWorkspaces()
  return resolveWorkspaceHandle(entries, handle)?.workspaceId ?? handle
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
  const workspaceId = await resolveWorkspaceHandleToId(handle)
  perRequest.set(handle, workspaceId)
  return workspaceId
}
