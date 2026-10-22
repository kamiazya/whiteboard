import {
  decodeSegment,
  isDotSegment,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import { formatWorkspaceAddress, parseWorkspaceAddress } from '@kamiazya/whiteboard-model'

// Canonical URL shapes for apps/web. Kept as pure string-building/parsing
// functions (no React Router import) so the shape is unit-testable without a
// router context.
//
// ONE grammar, for every keeper (ADR-0053 decision 2). Two grammars encode the
// KEEPER into the address, which is what three-layer identity exists to stop —
// and the keeper is not the URL's to say: ADR-0004 settles it once at page
// load, so one path means "this workspace, of whichever keeper this session
// runs". A single-person keeper spells its one namespace `me`.
//
// The `workspace` a route carries is an ADDRESS string in one of two forms:
// `<namespace>/<segment>`, what the app shows, or a bare canonical id, the
// opaque form a link that leaves the workspace carries. The first URL
// component tells them apart — a handle is never ULID-shaped. A one-component
// address that is not a ULID still parses, as the id form: an old
// `/w/<segment>` link then names nothing rather than being redirected, since
// choosing a namespace for it on a keeper with many people would mean
// resolving a bare segment across all of them.
export function indexPath(): string {
  return '/'
}

// Each component is encoded, the separator between them is not: it is the
// address's own, and encoding it would make a qualified address one opaque
// component that reads as the id form.
export function workspacePath(workspace: string): string {
  return `/w/${workspace.split('/').map(encodeURIComponent).join('/')}`
}

// Everything in a document's URL that its path does not decide.
//
// Exported because the forms that EDIT a path draw it in front of the box, so
// the field reads as the URL the text lands in rather than as a bare string.
// That affordance is only honest while it is the same value the router emits,
// which is why it is derived here instead of written out at the two form
// sites: a literal `/w/${w}/d/` in a component keeps looking right for as
// long as it takes somebody to move the grammar.
// The workspace list opened on the folder a document lives in — where a page
// goes when the document it showed is gone. A root-level document has no
// folder, so it gets the plain workspace address. `folder` is the list's own
// query parameter (useRoutedFolder).
export function workspaceFolderPath(workspace: string, documentPathInWorkspace: string): string {
  const folder = folderOfDocumentPath(documentPathInWorkspace)
  if (folder === '') return workspacePath(workspace)
  return `${workspacePath(workspace)}?${new URLSearchParams({ folder }).toString()}`
}

/** The folder a document path sits in; `''` for a root-level document. */
export function folderOfDocumentPath(documentPathInWorkspace: string): string {
  const cut = documentPathInWorkspace.lastIndexOf('/')
  return cut < 0 ? '' : documentPathInWorkspace.slice(0, cut)
}

export function documentPathPrefix(workspace: string): string {
  return `${workspacePath(workspace)}/d/`
}

// Nested under the workspace it belongs to, so the URL reads as placement.
// The tail is the document's path, one URL segment per path segment: each
// segment is encoded, the separators are not — encoding them would collapse
// the hierarchy the workspace shows into one opaque URL segment.
export function documentPath(workspace: string, path: string): string {
  const tail = path.split('/').map(encodeURIComponent).join('/')
  return `${documentPathPrefix(workspace)}${tail}`
}

export type WorkspaceRoute =
  | { kind: 'index'; workspace?: string; folder?: string }
  | { kind: 'document'; workspace: string; path: string }

/**
 * The decoded document path a URL tail spells, or null when any segment is
 * empty, undecodable, or a dot segment — `%2e%2e` decodes to `..`, which no
 * document path admits and which the API URL built from it would resolve
 * away.
 */
function documentTail(tail: string): string | null {
  const decoded = tail.split('/').map(decodeSegment)
  if (decoded.some((segment) => segment === null)) return null
  // Judged after the join: `%2F` decodes to a separator, so `a%2F..` is the
  // path `a/..` even though no single URL segment spelled `..`.
  const path = decoded.join('/')
  const segments = path.split('/')
  if (segments.includes('') || segments.some(isDotSegment)) return null
  return path
}

/** The address a qualified pair of URL components spells, or null when the address grammar refuses it. */
function qualifiedAddress(namespace: string, segment: string): string | null {
  const ns = decodeSegment(namespace)
  const seg = decodeSegment(segment)
  if (ns === null || seg === null) return null
  const address = parseWorkspaceAddress(`${ns}/${seg}`)
  return address?.form === 'qualified' ? formatWorkspaceAddress(address) : null
}

/** The route after `/w/` when it is a qualified address: `<ns>/<seg>` or `<ns>/<seg>/d/<path>`. */
function qualifiedRoute(rest: string): WorkspaceRoute | null {
  const documentMatch = /^([^/]+)\/([^/]+)\/d\/(.+?)\/?$/.exec(rest)
  if (documentMatch) {
    const workspace = qualifiedAddress(documentMatch[1] as string, documentMatch[2] as string)
    const path = documentTail(documentMatch[3] as string)
    return workspace === null || path === null ? null : { kind: 'document', workspace, path }
  }
  const indexMatch = /^([^/]+)\/([^/]+)\/?$/.exec(rest)
  if (indexMatch) {
    const workspace = qualifiedAddress(indexMatch[1] as string, indexMatch[2] as string)
    return workspace === null ? null : { kind: 'index', workspace }
  }
  return null
}

/** The route after `/w/` when it is a one-component (id-form) address: `<id>` or `<id>/d/<path>`. */
function idRoute(rest: string): WorkspaceRoute | null {
  const documentMatch = /^([^/]+)\/d\/(.+?)\/?$/.exec(rest)
  if (documentMatch) {
    const workspace = decodeSegment(documentMatch[1] as string)
    const path = documentTail(documentMatch[2] as string)
    return workspace === null || path === null ? null : { kind: 'document', workspace, path }
  }
  const indexMatch = /^([^/]+)\/?$/.exec(rest)
  if (indexMatch) {
    const workspace = decodeSegment(indexMatch[1] as string)
    return workspace === null ? null : { kind: 'index', workspace }
  }
  return null
}

// Deliberately regex-based rather than react-router's matchPath: App.tsx
// needs this result inside a useState lazy initializer (before any Route
// tree exists to match against), and keeping it framework-agnostic lets it
// be unit-tested without a Router context.
export function parseWorkspaceRoute(pathname: string): WorkspaceRoute | null {
  if (pathname === '/' || pathname === '') return { kind: 'index' }
  if (!pathname.startsWith('/w/')) return null
  const rest = pathname.slice('/w/'.length)
  // The qualified form first, so a segment spelled `d` stays addressable. It
  // cannot swallow an id-form address: the namespace grammar refuses a
  // ULID-shaped handle, so `/w/<id>/d/…` falls through to the id form.
  return qualifiedRoute(rest) ?? idRoute(rest)
}

// Inverse of parseWorkspaceRoute — the single place that turns a route back
// into the URL it should be addressable at, so App.tsx's state->URL sync and
// the parser can never drift from each other.
export function workspaceRoutePath(route: WorkspaceRoute): string {
  if (route.kind === 'document') return documentPath(route.workspace, route.path)
  return route.workspace ? workspacePath(route.workspace) : indexPath()
}

/**
 * Where the address bar goes for a route: its path, plus the folder an index
 * route was asked to open. The folder is a query, so it never takes part in
 * route equality (`workspaceRoutePath`).
 */
export function workspaceRouteTarget(route: WorkspaceRoute): string {
  const path = workspaceRoutePath(route)
  if (route.kind !== 'index' || route.folder === undefined || route.folder === '') return path
  return `${path}?${new URLSearchParams({ folder: route.folder }).toString()}`
}

export type SettingsSection = 'general' | 'data' | 'fonts' | 'connections' | 'developer'

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'general',
  'data',
  'fonts',
  'connections',
  'developer',
]

export function settingsPath(section?: SettingsSection): string {
  return section === undefined ? '/settings' : `/settings/${section}`
}

// A null `section` distinguishes the settings index (mobile: section list,
// desktop: General) from a section route; a null return value (the outer
// null) means "not a settings route at all".
export function parseSettingsRoute(pathname: string): { section: SettingsSection | null } | null {
  if (pathname === '/settings') return { section: null }
  const match = pathname.match(/^\/settings\/([^/]+)\/?$/)
  if (!match) return null
  const candidate = match[1]
  return SETTINGS_SECTIONS.includes(candidate as SettingsSection)
    ? { section: candidate as SettingsSection }
    : null
}

/**
 * Whether a pathname belongs to the app's closed route set. App.tsx shows
 * the not-found page for anything else, instead of silently falling through
 * to the default view — a mistyped or stale link should say so.
 */
export function isKnownAppPath(pathname: string): boolean {
  return parseSettingsRoute(pathname) !== null || parseWorkspaceRoute(pathname) !== null
}
