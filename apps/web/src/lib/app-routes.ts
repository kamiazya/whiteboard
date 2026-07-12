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
    return {
      kind: 'canvas',
      workspaceId: decodeURIComponent(canvasMatch[1]),
      slug: decodeURIComponent(canvasMatch[2]),
    }
  }
  const workspaceMatch = pathname.match(/^\/w\/([^/]+)\/?$/)
  if (workspaceMatch) {
    return { kind: 'index', workspaceId: decodeURIComponent(workspaceMatch[1]) }
  }
  if (pathname === '/' || pathname === '') {
    return { kind: 'index' }
  }
  return null
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
  return match ? { canvasId: decodeURIComponent(match[1]) } : null
}
