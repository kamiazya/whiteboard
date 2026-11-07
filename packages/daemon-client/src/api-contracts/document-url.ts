// The id-addressed document URLs a client builds and the daemon serves:
// `/api/workspaces/:workspaceId/documents/:documentId/<action>`, where the
// action is drawn from a closed set the server registers one route per. A
// document's id survives a rename, which is why nothing here takes a path.
//
// This file also keeps the segment codec every builder shares. It once held
// the path-addressed `/api/w/:workspaceId/document/<path>/<action>` family and
// its hand parser, retired with the path form (ADR-0009's id-as-address).

/**
 * One URL path segment, encoded. `encodeURIComponent` leaves dots alone, and
 * the URL parser fetch runs resolves a `.` or `..` segment before anything is
 * sent, so a URL built from one reaches a different same-origin `/api` path
 * than the one it names. No identifier or document path the model admits is
 * a dot segment (`DOCUMENT_PATH_SEGMENT_PATTERN` has no `.` at all), so one
 * arriving here is refused rather than built.
 */
export function encodePathSegment(segment: string): string {
  if (isDotSegment(segment)) {
    throw new Error(`refusing to build a URL from the dot segment ${JSON.stringify(segment)}`)
  }
  return encodeURIComponent(segment)
}

/** `.` or `..`: a segment the URL parser resolves rather than keeps. */
export function isDotSegment(segment: string): boolean {
  return segment === '.' || segment === '..'
}

/**
 * The closed set of actions a document route answers. The server registers
 * each one through `onDocumentAction`, typed by this union, so a name can be
 * added or renamed in one place only; `document-url-actions.test.ts` in
 * mcp-server requires a registered route behind every entry.
 */
export const DOCUMENT_API_ACTIONS = ['snapshot', 'export', 'export-svg', 'client-count'] as const

export type DocumentApiAction = (typeof DOCUMENT_API_ACTIONS)[number]

export function documentByIdApiUrl(
  workspaceId: string,
  documentId: string,
  action: DocumentApiAction,
): string {
  return `/api/workspaces/${encodePathSegment(workspaceId)}/documents/${encodePathSegment(documentId)}/${action}`
}

export function documentFileByIdApiUrl(
  workspaceId: string,
  documentId: string,
  fileId: string,
): string {
  return `/api/workspaces/${encodePathSegment(workspaceId)}/documents/${encodePathSegment(documentId)}/files/${encodePathSegment(fileId)}`
}

/** The workspace's own record, which a keeper moves between hosts (`snapshot`/`update`/`promote`). */
export const WORKSPACE_DOCUMENT_API_ACTIONS = ['snapshot', 'update', 'promote'] as const
export type WorkspaceDocumentApiAction = (typeof WORKSPACE_DOCUMENT_API_ACTIONS)[number]

export function workspaceDocumentApiUrl(
  workspaceId: string,
  action: WorkspaceDocumentApiAction,
): string {
  return `/api/w/${encodePathSegment(workspaceId)}/workspace-document/${action}`
}

/**
 * `decodeURIComponent` throws URIError on a malformed percent sequence
 * (`/w%1/main`). The web app's route parser runs in a render-phase
 * initializer, where a throw takes down the page; an unparseable address is
 * a not-a-route, so this answers null instead.
 */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}
