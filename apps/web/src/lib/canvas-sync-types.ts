import type {
  HeadChangedPayload,
  VersionCreatedPayload,
  ViewportRequestPayload,
} from '@kamiazya/whiteboard-mcp/browser-contract'

// Shared contract types/helpers for the canvas sync stack. These are plain,
// non-React values that both `hooks/useCanvasSync.ts` and
// `lib/canvas-sync-session.ts` depend on — living here (rather than in
// `hooks/`) keeps module imports flowing one direction only: hooks -> lib,
// never lib -> hooks.

// Dispatched on window as CustomEvent<DirtyEventDetail> by
// dispatchIdentityEvent below; consumed by hooks/useDirtyState.ts.
export interface DirtyEventDetail {
  workspaceId: string
  slug: string
}

/**
 * `reconnecting` is a live transport that has dropped and is being retried.
 * Distinct from `error`, which is terminal for this session, and from `idle`,
 * which is "not started" — a caller that conflated them would either alarm the
 * user over a blip or stay silent while nothing arrives.
 */
export type SyncStatus = 'idle' | 'connected' | 'reconnecting' | 'error'

// Named constants for the window-event contract dispatched by
// dispatchIdentityEvent below. The literal values are pinned — several other
// modules (useDirtyState, HeaderBranchBanner, useBranches,
// merge-committed-event) still match on the raw string and are out of this
// slice's scope, so changing the constant's NAME here must never change its
// VALUE.
export const CANVAS_SYNC_DOC_CHANGED_EVENT = 'excalidraw:doc_changed'
export const CANVAS_SYNC_VERSION_SAVED_EVENT = 'excalidraw:version_saved'

// Daemon-only callback seam. Every member is read via optionsRef in
// useCanvasSync (see there) so passing a fresh inline object on every render
// never forces a backend reconnect. A browser-local backend never fires any
// of these events, so none of them are called and the hook behaves exactly
// as before this seam was added.
export interface UseCanvasSyncOptions {
  onVersionCreated?: (payload: VersionCreatedPayload) => void
  onHeadChanged?: (payload: Omit<HeadChangedPayload, 'type'>) => void
  // Daemon-driven viewport control (e.g. an MCP tool call asking the
  // connected browser to fit/move its view). The page holds a
  // SpatialEditorHandle ref and maps this payload onto it — see
  // canvas-sync-session.ts's onViewportRequest forward.
  onViewportRequest?: (payload: Omit<ViewportRequestPayload, 'type'>) => void
  // Fired in addition to (not instead of) the hook's own syncStatus:'error'
  // transition on a WS auth failure (close 1008), so a daemon-backed page
  // can surface a dedicated banner instead of the generic error state.
  onAuthError?: () => void
  // When set, drives the window-event contract that useDirtyState/HeaderSaveDot
  // listen for: 'excalidraw:doc_changed' on local/remote doc edits and
  // 'excalidraw:version_saved' on a version_created broadcast. Read via
  // optionsRef (never in the connect effect's dep array) so passing a fresh
  // identity object every render never forces a reconnect. Only dispatched
  // when both fields are present — a browser-local caller that never sets
  // this option (or a daemon caller whose identity is still resolving)
  // dispatches nothing, leaving its dirty-state behavior unchanged.
  identity?: { workspaceId: string; slug: string }
}

// Dispatches a window event carrying { workspaceId, slug } as detail, but only
// when identity is fully resolved — a partial or absent identity means the
// caller (browser-local, or a daemon page whose identity is still loading)
// never wired the dirty-state contract and must see no events at all.
export function dispatchIdentityEvent(
  eventName: string,
  identity: UseCanvasSyncOptions['identity'],
): void {
  if (typeof window === 'undefined') return
  if (!identity?.workspaceId || !identity.slug) return
  const detail: DirtyEventDetail = { workspaceId: identity.workspaceId, slug: identity.slug }
  window.dispatchEvent(new CustomEvent(eventName, { detail }))
}
