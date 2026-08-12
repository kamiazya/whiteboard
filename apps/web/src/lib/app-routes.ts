// Canonical URL shapes for apps/web. Kept as pure string-building/parsing
// functions (no React Router import) so the shape is unit-testable without a
// router context and has exactly one place that can drift from
// DaemonDetectedBanner's deep link (which builds the same
// `/canvas/:workspaceId/:slug` shape independently, since it runs on a
// different origin — the daemon's — and cannot import a client-side route
// table).
export function indexPath(): string {
  return '/'
}

export function workspacePath(workspaceId: string): string {
  return `/w/${encodeURIComponent(workspaceId)}`
}

export function canvasPath(workspaceId: string, slug: string): string {
  return `/canvas/${encodeURIComponent(workspaceId)}/${encodeURIComponent(slug)}`
}

export function browserLocalIndexPath(): string {
  return '/local'
}

export function browserLocalCanvasPath(canvasId: string): string {
  return `/local/${encodeURIComponent(canvasId)}`
}

export type DaemonRoute =
  | { kind: 'index'; workspaceId?: string }
  | { kind: 'canvas'; workspaceId: string; slug: string }

// Deliberately regex-based rather than react-router's matchPath: App.tsx
// needs this result inside a useState lazy initializer (before any Route
// tree exists to match against), and keeping it framework-agnostic lets it
// be unit-tested without a Router context.
export function parseDaemonRoute(pathname: string): DaemonRoute | null {
  const canvasMatch = pathname.match(/^\/canvas\/([^/]+)\/([^/]+)\/?$/)
  if (canvasMatch) {
    const workspaceId = decodeSegment(canvasMatch[1])
    const slug = decodeSegment(canvasMatch[2])
    if (workspaceId === null || slug === null) return null
    return { kind: 'canvas', workspaceId, slug }
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
// (`/canvas/w%1/main`). These parsers run inside render-phase lazy
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
  if (route.kind === 'canvas') return canvasPath(route.workspaceId, route.slug)
  return route.workspaceId ? workspacePath(route.workspaceId) : indexPath()
}

export function parseBrowserLocalRoute(pathname: string): { canvasId: string } | null {
  const match = pathname.match(/^\/local\/([^/]+)\/?$/)
  if (!match) return null
  const canvasId = decodeSegment(match[1])
  return canvasId === null ? null : { canvasId }
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
