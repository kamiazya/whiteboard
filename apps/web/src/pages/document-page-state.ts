// The page-level render-state vocabulary both document pages draw from —
// ADR-0004 decision 3, as built. The DERIVE stays per-keeper
// (browser-page-state.ts / daemon-page-state.ts) because the inputs are
// keeper-specific and ADR-0004 decision 2 keeps the controllers
// capability-selected; what is declared once here is the states themselves,
// so a state added for one keeper is a visible decision about the other
// rather than a silent divergence.
//
// Which keeper produces which state, and why the other cannot:
//
// - `loading`, `load-degraded`, `editing`: both keepers.
// - `cleanup-completed`: browser only. Deleting the retained browser copy
//   leaves the page with nothing to load and no list to fall back to; the
//   daemon page never faces this — its delete flows navigate back to an
//   index that still exists on the daemon.
// - `document-missing`, `workspace-empty`: daemon only. The browser
//   controller resolves a default document on mount (and repairs a stale
//   /local/ URL to the loaded document), so "nothing at this address" and
//   "no documents at all" both collapse into a successful load there.

export interface LoadingState {
  kind: 'loading'
}

/**
 * The load itself failed and there is nothing user-meaningful to render.
 * `message` is carried verbatim from whichever source reported the failure,
 * so no page re-narrows its controller state to read it. Recovery
 * affordances are keeper-specific and travel as children of the shared view.
 */
export interface LoadDegradedState {
  kind: 'load-degraded'
  message: string
}

/** Browser only: the user just deleted the retained browser copy. */
export interface CleanupCompletedState {
  kind: 'cleanup-completed'
}

/**
 * Daemon only: the URL names a path the (non-empty) documents list does not
 * contain — deleted, renamed, or never existed. Rendered as an explicit
 * create-at-this-path offer; connecting anyway used to mint a blank canvas
 * at the stale path on the first edit.
 */
export interface DocumentMissingState {
  kind: 'document-missing'
  path: string
}

/** Daemon only: the workspace resolved but holds no documents yet. */
export interface WorkspaceEmptyState {
  kind: 'workspace-empty'
}

/**
 * Steady state: the editor renders. Keeper-specific payload (the browser's
 * snapshot + persistence) is intersected on by the keeper's own union.
 */
export interface EditingState {
  kind: 'editing'
}
