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
