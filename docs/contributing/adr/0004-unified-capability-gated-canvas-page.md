# ADR-0004: Unified capability-gated CanvasPage

**Status:** Accepted

## Context

`apps/web` must support two operating modes long-term: browser-local (no
daemon, IndexedDB-backed Loro doc) and daemon-connected (WebSocket + REST
sync, ADR-0002). The `CanvasBackend` seam already exists as the behavioral
interface swapped at the page level.

Additional constraints from architecture and UX review:

- Branches, the version-history timeline, and the branch banner / merge toast
  are daemon-only concepts; browser-local has no equivalent state.
- The daemon side has no single controller today — the index page's ad-hoc
  `apiFetch` calls and `useBranches` are the existing daemon-side
  data-fetching shape, separate from the browser-local controller.
- Mode is decided once at page load (config + probe result), not switched at
  runtime within a session.
- `apps/web` has no router today; the daemon-served `src/app` already has one.

## Decision

Adopt a single `CanvasPage` component that receives an injected
`CanvasBackend` and renders capability-gated JSX, rather than maintaining
separate pages per mode or building a fully generic `CanvasController`
abstraction.

1. **One page, capability-gated chrome.** `CanvasPage` owns the
   header/editor/state-machine shell for both modes. Slots that apply only to
   one mode (branch chip, History, Merge) render through a shared
   teaser/live-widget pair driven by capability flags rather than by
   branching the page identity. This keeps the eventual removal of the
   daemon-served UI (ADR-0001 Stage 5) to a local diff of conditionals.
2. **Controller layer stays capability-selected, not force-unified (YAGNI).**
   `useBrowserLocalCanvasController` encodes IndexedDB-specific invariants
   (serialized `flushSave`, orphan rollback on `createCanvas`, pointer
   ordering in `startFresh`) that do not map onto a generic repository
   interface without leaking or breaking them. The daemon side has no single
   controller to unify against yet. `CanvasPage` selects the controller hook
   based on `ProviderState.kind`; the shared shape between controllers is
   limited to the fields the header actually branches on.
3. **Daemon connectivity is a sub-state of `editing`.** The page state
   machine is `load-degraded | cleanup-completed (browser-local only) |
   loading | { kind: 'editing', snapshot, persistence, overlay:
   EditingOverlay }`, where `EditingOverlay = none | { restoring, label? } |
   auth-error`. The existing `derivePageState` cascade-order invariant is
   preserved unchanged. Branch banner and merge toast render as
   capability-gated JSX inside `editing` — chrome, not a distinct page state.
4. **Introduce React Router in `apps/web`.** `/` renders the canvas list
   (browser-local populates from IndexedDB; daemon mode uses the existing
   grid/search/pin pattern). `/canvas/:id/*slug` is the shared editor URL for
   both modes (`:id` is the IndexedDB id with an empty slug in browser-local,
   or `workspaceId` + slug in daemon mode), giving both modes an equivalent
   bookmarkable, deep-linkable URL.
5. **Mode is a read-only status decided at page load.** There is no
   in-session runtime toggle between browser-local and daemon mode.

## Consequences

- ADR-0001 Stage 5 (removing the daemon-served UI) reduces to deleting
  capability-gated branches inside the unified `CanvasPage`, not a parallel
  page tree.
- Daemon-only affordances render as a teaser when unavailable instead of
  being absent, giving browser-local users visibility into daemon-only
  functionality without implying it currently works.
- Dependencies that must land alongside or before this work: porting
  `useThemeMode` into `apps/web` (currently absent there), capability-gating
  the library-import effect (currently an unguarded effect in the daemon
  page that would silently no-op under browser-local), and exporting
  `apiFetch` and the API-contract schemas from stable subpaths so
  daemon-side fetch logic can be reused rather than copy-pasted.
- The `window` event bus (`excalidraw:head_changed`, `merge_committed`) that
  `useBranches` uses to coordinate with the sync hook: sync-originated
  events move to hook callbacks (bound to backend identity, eliminating
  stale-listener classes), while UI-originated `merge_committed` stays on the
  window bus with its payload promoted to a Zod-validated contract.
- As of this decision, `apps/web` has no router, and the shared
  `CanvasPage` / capability-gated controller selection are unimplemented
  follow-up slices — this ADR records the accepted design, not a completed
  migration.
- Several UX details remain open for product decision (narrow-viewport
  overflow-collapse breakpoint, mode-indicator dismissibility, a
  browser-local "Optimize" equivalent, Delete placement, offline-toast
  threshold, and how Workspaces surfaces in browser-local). These do not
  block the architecture but should be resolved before the corresponding UI
  slice ships.

## Alternatives considered

**Keep separate pages per mode.** Rejected: perpetuates duplicate management
of fullscreen/theme/shortcut logic across two page implementations and
repeats a failure mode already seen once — a feature ported to the daemon
path while the browser-local path is forgotten.

**Fully generic `CanvasController` abstraction unifying browser-local and
daemon data access.** Rejected as speculative generality: browser-local's
IndexedDB invariants have no daemon-side equivalent to unify against, and the
daemon side itself has no single controller to unify with yet — that
consolidation is a separate, currently out-of-scope effort.

**Runtime mode switching within a single session.** Rejected: no product
requirement calls for switching without a reload, and treating mode as
load-time-fixed simplifies event-listener lifecycle handling.
