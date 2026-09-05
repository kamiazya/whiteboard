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
- `apps/web` has no router today; the original daemon-served UI (since retired) already had one.

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
   grid/search/pin pattern). `/canvas/:id/*` is the shared editor URL for
   both modes — the trailing splat carries the slug, read via `params['*']`
   per React Router v6 conventions (`:id` is the IndexedDB id with an empty
   splat in browser-local, or `workspaceId` + slug in daemon mode) — giving
   both modes an equivalent bookmarkable, deep-linkable URL.
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

## Addendum (2026-08-12): what shipped differs from three premises above

Recorded as-built rather than rewriting the decision:

- **Route shape.** Point 4's single shared `/canvas/:id/*` editor URL was
  not what shipped. The modes have distinct routes — `/canvas/:workspaceId/:slug`
  (daemon) and `/local/:canvasId` (browser-local) — matching their distinct
  identities (see [ADR-0007](0007-canvas-identity-and-store-split.md)).
  `/` landing on a canvas list is now true in both modes via the shared
  `CanvasListView`.
- **"Unimplemented follow-up slices."** The router, capability-gated
  chrome, and the shared list have since landed; that consequence bullet
  is historical.
- **Open UX details.** Two of the listed open product decisions are now
  decided: workspaces surface in browser-local as a fixed single
  workspace modeled as present (ADR-0007), and Delete's placement is a
  per-card action on the shared list with a confirmation dialog.

## Addendum (2026-09-01): the page state machine is shared code now

Decision 3's state machine is implemented as a shared vocabulary rather
than as two per-page shapes: `apps/web/src/pages/document-page-state.ts`
declares every page-level render state once, each annotated with which
keeper produces it and why the other cannot, and each page derives its own
machine from its own controller's fields — `browser-page-state.ts` (plus
the content-read-failure refinement) and `daemon-page-state.ts`. Two
daemon-only states postdate the decision text: `document-missing` (a stale
URL against a non-empty documents list, rendered as an explicit
create-at-this-path offer) and `workspace-empty`. The controller layer
stays capability-selected exactly as decision 2 requires.

`EditingOverlay` as written did not ship: restore progress lives in editor
chrome, and a WS auth rejection surfaces through the favicon and the shell
connection status (`sync-off`) rather than as a page-level overlay state.
`page-state-conformance.test.ts` pins both pages' use of the shared
machine, and the shared `load-degraded` state renders through one
`LoadDegradedView` in both modes.

## Addendum (2026-09-05): the page body is shared code now

Decision 1's "one page" is implemented one step further than the 2026-09-01
addendum recorded. `apps/web/src/pages/DocumentPage.tsx` renders the shell,
the history column, the merged header row, the editor surface and the
comments rail ONCE, from a `DocumentPageModel`
(`pages/document-page-model.ts`); `BrowserDocumentPage` and
`DaemonDocumentPage` remain as the keeper pages that build that model —
controller, sync backend, markdown body, versions, and the chrome only their
keeper has, handed over through named slots — and render the shared page.

Decision 2 is unchanged: the controller layer stays capability-selected, and
the model is not a generic controller. It carries only the facts the shared
page actually branches on, and the keeper-specific supply behind each fact
(IndexedDB rows versus daemon routes, a Loro-bound CodeMirror versus the sync
session's `set-body`) stays inside the keeper page.

What this closes is the alternative this ADR rejected — "a feature ported to
the daemon path while the browser-local path is forgotten" — for everything
in the shared body: a prop reaches both keepers or it does not compile. The
conformance scans that pinned the two pages equal (`file-seam-conformance`,
`save-conformance`) now pin ownership instead: shared chrome stays in the
shared page, keeper-only chrome is rendered by its keeper page and no other.
The `spatial-pane-conformance` scan is deleted — with one render site there
is no second prop set to drift.

Named follow-up: the keeper pages themselves become two implementations of
one `DocumentKeeper` contract behind a single `DocumentPage` entry, with one
contract suite run against both, so App selects a keeper rather than a page.
The markdown body's two write paths (the browser hook's own scheduler versus
the sync session) are a separate increment: unifying them changes when a
save lands, and that is judged by measurement, not by refactor.
