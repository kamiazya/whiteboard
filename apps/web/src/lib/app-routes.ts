// Canonical URL shapes for apps/web. Kept as pure string-building/parsing
// functions (no React Router import) so the shape is unit-testable without a
// router context and has exactly one place that can drift from
// DaemonDetectedBanner's deep link (which builds the same
// `/w/:workspace/d/*` shape independently, since it runs on a
// different origin — the daemon's — and cannot import a client-side route
// table).
//
// ONE grammar, for both keepers. The browser kept a `/local/*` family of its
// own until ADR-0019 gave a browser workspace a segment to be named by;
// before that it had no address to put there, and the shape said so. Two
// grammars encode the KEEPER into the address, which is what three-layer
// identity exists to stop — and the keeper is not the URL's to say: ADR-0004
// settles it once at page load, so one path means "this workspace, of
// whichever keeper this session runs".
//
// The parameter is a HANDLE, not an id. ADR-0019 resolves an address
// segment-first with the canonical id as the durable fallback, so this layer
// deliberately does not know which of the two it is carrying.
export function indexPath(): string {
  return '/'
}

export function workspacePath(workspace: string): string {
  return `/w/${encodeURIComponent(workspace)}`
}

// Everything in a document's URL that its path does not decide.
//
// Exported because the forms that EDIT a path draw it in front of the box, so
// the field reads as the URL the text lands in rather than as a bare string.
// That affordance is only honest while it is the same value the router emits,
// which is why it is derived here instead of written out at the two form
// sites: a literal `/w/${w}/d/` in a component keeps looking right for as
// long as it takes somebody to move the grammar.
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
  | { kind: 'index'; workspace?: string }
  | { kind: 'document'; workspace: string; path: string }

// Deliberately regex-based rather than react-router's matchPath: App.tsx
// needs this result inside a useState lazy initializer (before any Route
// tree exists to match against), and keeping it framework-agnostic lets it
// be unit-tested without a Router context.
export function parseWorkspaceRoute(pathname: string): WorkspaceRoute | null {
  // The document branch is checked first: `/w/:ws` and `/w/:ws/d/...`
  // share a prefix, and the workspace pattern below is anchored so it cannot
  // swallow a document URL either way.
  const documentMatch = pathname.match(/^\/w\/([^/]+)\/d\/(.+?)\/?$/)
  if (documentMatch) {
    const workspace = decodeSegment(documentMatch[1])
    const segments = (documentMatch[2] as string).split('/').map(decodeSegment)
    if (workspace === null || segments.some((segment) => segment === null || segment === '')) {
      return null
    }
    return { kind: 'document', workspace, path: segments.join('/') }
  }
  const workspaceMatch = pathname.match(/^\/w\/([^/]+)\/?$/)
  if (workspaceMatch) {
    const workspace = decodeSegment(workspaceMatch[1])
    return workspace === null ? null : { kind: 'index', workspace }
  }
  if (pathname === '/' || pathname === '') {
    return { kind: 'index' }
  }
  return null
}

// decodeURIComponent throws URIError on a malformed percent sequence
// (`/w/w%1/d/main`). These parsers run inside render-phase lazy
// initializers, so a throw here takes down the whole app; an unparseable URL
// is a not-a-route, not a crash.
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

// Inverse of parseWorkspaceRoute — the single place that turns a route back
// into the URL it should be addressable at, so App.tsx's state->URL sync and
// the parser can never drift from each other.
export function workspaceRoutePath(route: WorkspaceRoute): string {
  if (route.kind === 'document') return documentPath(route.workspace, route.path)
  return route.workspace ? workspacePath(route.workspace) : indexPath()
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
  return (
    pathname === '/pair' ||
    parseSettingsRoute(pathname) !== null ||
    parseWorkspaceRoute(pathname) !== null
  )
}
