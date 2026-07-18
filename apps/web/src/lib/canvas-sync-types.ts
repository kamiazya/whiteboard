import type {
  HeadChangedPayload,
  VersionCreatedPayload,
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

export type SyncStatus = 'idle' | 'connected' | 'error'

// Daemon-only callback seam. Every member is read via optionsRef in
// useCanvasSync (see there) so passing a fresh inline object on every render
// never forces a backend reconnect. A browser-local backend never fires any
// of these events, so none of them are called and the hook behaves exactly
// as before this seam was added.
export interface UseCanvasSyncOptions {
  onVersionCreated?: (payload: VersionCreatedPayload) => void
  onHeadChanged?: (payload: Omit<HeadChangedPayload, 'type'>) => void
  onFileUploadFailed?: () => void
  onFileUploadSucceeded?: () => void
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
  if (!identity || !identity.workspaceId || !identity.slug) return
  const detail: DirtyEventDetail = { workspaceId: identity.workspaceId, slug: identity.slug }
  window.dispatchEvent(new CustomEvent(eventName, { detail }))
}
