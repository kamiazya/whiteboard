/**
 * The sync wire's doc keys and the daemon routes a key addresses.
 *
 * Both sides of the wire speak this grammar — the daemon's stream registry
 * keys its audiences by it, the client hub subscribes and writes by it — so it
 * lives in a module of its own rather than inside either side's machinery.
 */

import { documentApiUrl, workspaceDocumentApiUrl } from './api-contracts/document-url.js'

/**
 * The workspace-granularity doc key: one subscription for the whole
 * workspace document. Unambiguous against `${workspaceId}/${path}` keys
 * because a workspace id contains no ':' and no '/', so no per-document
 * key ever starts with this prefix without a slash following it.
 */
const WORKSPACE_DOC_KEY_PREFIX = 'workspace:'

export function workspaceDocKey(workspaceId: string): string {
  return `${WORKSPACE_DOC_KEY_PREFIX}${workspaceId}`
}

/**
 * The per-document sync key: `${handle}/${path}`, the grammar
 * `workspaceHandleOfSyncKey` splits on the first slash. The daemon's stream
 * registry, the client backend and the page's identity key all spell it
 * through here, so a change to the join reaches the parser it must agree with.
 */
export function documentSyncKey(handle: string, path: string): string {
  return `${handle}/${path}`
}

/**
 * The workspace id a workspace-granularity sync key names, or `null` for any
 * other key — a per-document key, the bare prefix, or the STORED key shape
 * (`workspace-tree:<id>`, ports' `docRefKey`, a different grammar).
 */
export function workspaceIdOfSyncKey(doc: string): string | null {
  if (!doc.startsWith(WORKSPACE_DOC_KEY_PREFIX)) return null
  const workspaceId = doc.slice(WORKSPACE_DOC_KEY_PREFIX.length)
  return workspaceId.length === 0 ? null : workspaceId
}

/**
 * The workspace a sync key addresses, for a caller that needs it rather than
 * the route — the daemon's membership gate, in particular, decides once per
 * workspace rather than per document key. A `workspace:` key names it
 * directly; a per-document key is `${handle}/${path}`, split on the first
 * slash (a path may contain more, a handle never does). What comes back is
 * the HANDLE the client wrote, which a daemon resolves to an id before it
 * keys anything by it. `null` for a malformed key — `documentRouteUrl` refuses
 * through this same split.
 */
export function workspaceHandleOfSyncKey(doc: string): string | null {
  if (doc.startsWith(WORKSPACE_DOC_KEY_PREFIX)) return workspaceIdOfSyncKey(doc)
  const slash = doc.indexOf('/')
  if (slash <= 0 || slash === doc.length - 1) return null
  return doc.slice(0, slash)
}

/**
 * The daemon's update route for a doc key.
 *
 * A per-document key IS `${workspaceId}/${path}`, which is the only reason
 * anything holding just the key can address this route (first slash only: a
 * path may contain more, a workspace id never does). A `workspace:` key
 * addresses the workspace-document routes instead.
 */
export function documentUpdateUrl(baseUrl: string, doc: string): string | null {
  return documentRouteUrl(baseUrl, doc, 'update')
}

/** The snapshot twin of `documentUpdateUrl`, splitting on the same first slash. */
export function documentSnapshotUrl(baseUrl: string, doc: string): string | null {
  return documentRouteUrl(baseUrl, doc, 'snapshot')
}

function documentRouteUrl(
  baseUrl: string,
  doc: string,
  action: 'update' | 'snapshot',
): string | null {
  const base = baseUrl.replace(/\/$/, '')
  const workspaceId = workspaceHandleOfSyncKey(doc)
  if (workspaceId === null) return null
  if (workspaceIdOfSyncKey(doc) !== null) {
    return `${base}${workspaceDocumentApiUrl(workspaceId, action)}`
  }
  // Raw halves: documentApiUrl encodes per segment itself.
  return `${base}${documentApiUrl(workspaceId, doc.slice(workspaceId.length + 1), action)}`
}
