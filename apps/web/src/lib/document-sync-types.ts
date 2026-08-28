import type {
  AgentActivityPayload,
  HeadChangedPayload,
  VersionCreatedPayload,
  ViewportRequestPayload,
} from '@kamiazya/whiteboard-mcp/browser-contract'

// Shared contract types/helpers for the canvas sync stack. These are plain,
// non-React values that both `hooks/useDocumentSync.ts` and
// `lib/document-sync-session.ts` depend on — living here (rather than in
// `hooks/`) keeps module imports flowing one direction only: hooks -> lib,
// never lib -> hooks.

// Dispatched on window as CustomEvent<DirtyEventDetail> by
// dispatchIdentityEvent below; consumed by hooks/useDirtyState.ts.
export interface DirtyEventDetail {
  workspaceId: string
  path: string
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
export const DOCUMENT_SYNC_CHANGED_EVENT = 'whiteboard:doc_changed'
export const DOCUMENT_SYNC_VERSION_SAVED_EVENT = 'whiteboard:wb_version_saved'

// Daemon-only callback seam. Every member is read via optionsRef in
// useDocumentSync (see there) so passing a fresh inline object on every render
// never forces a backend reconnect. A browser backend never fires any
// of these events, so none of them are called and the hook behaves exactly
// as before this seam was added.
export interface UseDocumentSyncOptions {
  onVersionCreated?: (payload: VersionCreatedPayload) => void
  onHeadChanged?: (payload: Omit<HeadChangedPayload, 'type'>) => void
  // Daemon-driven viewport control (e.g. an MCP tool call asking the
  // connected browser to fit/move its view). The page holds a
  // SpatialEditorHandle ref and maps this payload onto it — see
  // document-sync-session.ts's onViewportRequest forward.
  onViewportRequest?: (payload: Omit<ViewportRequestPayload, 'type'>) => void
  // An agent changed this document. The change itself arrives as an ordinary
  // Loro update; this says who did it and what to draw attention to, so the
  // page can show a presence chip and outline what moved.
  onAgentActivity?: (payload: Omit<AgentActivityPayload, 'type'>) => void
  // Fired in addition to (not instead of) the hook's own syncStatus:'error'
  // transition on a WS auth failure (close 1008), so a daemon-backed page
  // can surface a dedicated banner instead of the generic error state.
  onAuthError?: () => void
  // When set, drives the window-event contract that useDirtyState/HeaderSaveDot
  // listen for: 'whiteboard:doc_changed' on local/remote doc edits and
  // 'whiteboard:wb_version_saved' on a version_created broadcast. Read via
  // optionsRef (never in the connect effect's dep array) so passing a fresh
  // identity object every render never forces a reconnect. Only dispatched
  // when both fields are present — a browser caller that never sets
  // this option (or a daemon caller whose identity is still resolving)
  // dispatches nothing, leaving its dirty-state behavior unchanged.
  identity?: { workspaceId: string; path: string }
  /**
   * When the backend delivers a WORKSPACE document (one Loro doc holding
   * every document as a tree node), this names the document whose content
   * this session edits — see SessionDeps.contentDocumentId. Captured when
   * the session is constructed (a backend identity change), never re-read
   * live: a different document is a different backend, so the two always
   * travel together.
   */
  contentDocumentId?: string
}

// Dispatches a window event carrying { workspaceId, path } as detail, but only
// when identity is fully resolved — a partial or absent identity means the
// caller (the browser, or a daemon page whose identity is still loading)
// never wired the dirty-state contract and must see no events at all.
export function dispatchIdentityEvent(
  eventName: string,
  identity: UseDocumentSyncOptions['identity'],
): void {
  if (typeof window === 'undefined') return
  if (!identity?.workspaceId || !identity.path) return
  const detail: DirtyEventDetail = { workspaceId: identity.workspaceId, path: identity.path }
  window.dispatchEvent(new CustomEvent(eventName, { detail }))
}
