// The one place the live-canvas API's URL shape is written down. The server
// parses request paths with parseDocumentApiPath; every client builds request
// URLs through documentApiUrl. Both sides importing this file is what keeps
// them from drifting apart segment by segment.
//
// Shape: /api/w/:workspaceId/document/<document path>/<action>
//
// The document path is multi-segment (`notes/2026/plan`), so the action
// suffix is what makes parsing unambiguous: it is mandatory and drawn from a
// closed set, so stripping the known action off the end leaves exactly the
// path — including a document whose own last segment collides with an action
// name (`.../document/a/snapshot/snapshot` is the document `a/snapshot`).

/** Per-segment encoding: the separators are structure, not data. */
export function encodeDocumentPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * The closed set of actions a document route answers. The server registers
 * each one through `onDocumentAction`, typed by this union, so a name can be
 * added or renamed in one place only; `document-url-actions.test.ts` in
 * mcp-server requires a registered route behind every entry.
 */
export const DOCUMENT_API_ACTIONS = [
  'snapshot',
  'exists',
  'update',
  'export',
  'export-svg',
  'client-count',
] as const

export type DocumentApiAction = (typeof DOCUMENT_API_ACTIONS)[number]

export function documentApiUrl(
  workspaceId: string,
  path: string,
  action: DocumentApiAction,
): string {
  return `/api/w/${encodeURIComponent(workspaceId)}/document/${encodeDocumentPath(path)}/${action}`
}

export function documentFileApiUrl(workspaceId: string, path: string, fileId: string): string {
  return `/api/w/${encodeURIComponent(workspaceId)}/document/${encodeDocumentPath(path)}/file/${encodeURIComponent(fileId)}`
}

/** The workspace's own record, which a keeper moves between hosts (`snapshot`/`update`/`promote`). */
export const WORKSPACE_DOCUMENT_API_ACTIONS = ['snapshot', 'update', 'promote'] as const
export type WorkspaceDocumentApiAction = (typeof WORKSPACE_DOCUMENT_API_ACTIONS)[number]

export function workspaceDocumentApiUrl(
  workspaceId: string,
  action: WorkspaceDocumentApiAction,
): string {
  return `/api/w/${encodeURIComponent(workspaceId)}/workspace-document/${action}`
}

/**
 * Splits a request path in the shape above into its parts, or null when it
 * is not one. Written by hand rather than as a Hono `{.+}` param: Hono's
 * SmartRouter picks its underlying router on the FIRST request, and with the
 * full route table that pick lands on one where a regex param cannot span
 * slashes — the route then 404s, but only after some other request has been
 * served first, which is as misleading as bugs get. A wildcard route plus
 * this parse depends on no router internals.
 *
 * Segments are percent-decoded one by one; a malformed segment makes the
 * whole path not-a-match rather than a throw.
 */
export function parseDocumentApiPath(
  requestPath: string,
): { workspaceId: string; tail: string[] } | null {
  const match = requestPath.match(/^\/api\/w\/([^/]+)\/document\/(.+)$/)
  if (match === null) return null
  const workspaceId = decodeSegment(match[1])
  const tail = match[2].split('/').map(decodeSegment)
  if (workspaceId === null || tail.some((segment) => segment === null || segment === '')) {
    return null
  }
  return { workspaceId, tail: tail as string[] }
}

/** The document path when the tail ends in `action`, else null. */
export function documentPathForAction(tail: string[], action: string): string | null {
  if (tail.length < 2 || tail[tail.length - 1] !== action) return null
  return tail.slice(0, -1).join('/')
}

/** The document path + fileId when the tail is `<path>/file/<fileId>`, else null. */
export function documentPathForFile(tail: string[]): { path: string; fileId: string } | null {
  if (tail.length < 3 || tail[tail.length - 2] !== 'file') return null
  return { path: tail.slice(0, -2).join('/'), fileId: tail[tail.length - 1] as string }
}

/**
 * `decodeURIComponent` throws URIError on a malformed percent sequence
 * (`/w/w%1/d/main`). Parsers run in render-phase initializers and request
 * handlers, where a throw takes down the app or the request; an unparseable
 * address is a not-a-route, so this answers null instead.
 */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}
