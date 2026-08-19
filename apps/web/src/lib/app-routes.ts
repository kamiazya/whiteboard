// Canonical URL shapes for apps/web. Kept as pure string-building/parsing
// functions (no React Router import) so the shape is unit-testable without a
// router context and has exactly one place that can drift from
// DaemonDetectedBanner's deep link (which builds the same
// `/w/:workspaceId/document/*` shape independently, since it runs on a
// different origin — the daemon's — and cannot import a client-side route
// table).
export function indexPath(): string {
  return '/'
}

export function workspacePath(workspaceId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}`
}

// Nested under the workspace it belongs to, so the URL reads as placement.
// The tail is the document's path, one URL segment per path segment: each
// segment is encoded, the separators are not — encoding them would collapse
// the hierarchy the workspace shows into one opaque URL segment.
export function documentPath(workspaceId: string, path: string): string {
  const tail = path.split('/').map(encodeURIComponent).join('/')
  return `${workspacePath(workspaceId)}/document/${tail}`
}

export function browserLocalIndexPath(): string {
  return '/local'
}

// Per-segment encoding, separators left alone — the same rule `documentPath`
// follows for the daemon. Encoding the separators would collapse a hierarchy
// the browser shows into one opaque URL segment.
export function browserLocalDocumentPath(path: string): string {
  return `/local/${path.split('/').map(encodeURIComponent).join('/')}`
}

export type DaemonRoute =
  | { kind: 'index'; workspaceId?: string }
  | { kind: 'document'; workspaceId: string; path: string }

// Deliberately regex-based rather than react-router's matchPath: App.tsx
// needs this result inside a useState lazy initializer (before any Route
// tree exists to match against), and keeping it framework-agnostic lets it
// be unit-tested without a Router context.
export function parseDaemonRoute(pathname: string): DaemonRoute | null {
  // The canvas branch is checked first: `/w/:ws` and `/w/:ws/document/...`
  // share a prefix, and the workspace pattern below is anchored so it cannot
  // swallow a canvas URL either way.
  const canvasMatch = pathname.match(/^\/w\/([^/]+)\/document\/(.+?)\/?$/)
  if (canvasMatch) {
    const workspaceId = decodeSegment(canvasMatch[1])
    const segments = (canvasMatch[2] as string).split('/').map(decodeSegment)
    if (workspaceId === null || segments.some((segment) => segment === null || segment === '')) {
      return null
    }
    return { kind: 'document', workspaceId, path: segments.join('/') }
  }
  const workspaceMatch = pathname.match(/^\/w\/([^/]+)\/?$/)
  if (workspaceMatch) {
    const workspaceId = decodeSegment(workspaceMatch[1])
    return workspaceId === null ? null : { kind: 'index', workspaceId }
  }
  if (pathname === '/' || pathname === '') {
    return { kind: 'index' }
  }
  return null
}

// decodeURIComponent throws URIError on a malformed percent sequence
// (`/w/w%1/document/main`). These parsers run inside render-phase lazy
// initializers, so a throw here takes down the whole app; an unparseable URL
// is a not-a-route, not a crash.
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

// Inverse of parseDaemonRoute — the single place that turns a DaemonView
// back into the URL it should be addressable at, so App.tsx's state->URL
// sync and parseDaemonRoute can never drift from each other.
export function daemonRoutePath(route: DaemonRoute): string {
  if (route.kind === 'document') return documentPath(route.workspaceId, route.path)
  return route.workspaceId ? workspacePath(route.workspaceId) : indexPath()
}

export function parseBrowserLocalRoute(pathname: string): { path: string } | null {
  const match = pathname.match(/^\/local\/(.+?)\/?$/)
  if (!match) return null
  const segments = (match[1] as string).split('/').map(decodeSegment)
  if (segments.some((segment) => segment === null || segment === '')) return null
  return { path: segments.join('/') }
}

export type SettingsSection = 'general' | 'data' | 'connections'

const SETTINGS_SECTIONS: readonly SettingsSection[] = ['general', 'data', 'connections']

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
    pathname === browserLocalIndexPath() ||
    parseBrowserLocalRoute(pathname) !== null ||
    parseSettingsRoute(pathname) !== null ||
    parseDaemonRoute(pathname) !== null
  )
}
