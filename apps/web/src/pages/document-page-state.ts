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
// - `document-missing`, `workspace-empty`: daemon only. The browser
//   controller resolves a default document on mount (and repairs a stale
//   /local/ URL to the loaded document), so "nothing at this address" and
//   "no documents at all" both collapse into a successful load there.

import {
  type DocumentReadFailure,
  documentReadFailureMessage,
} from '../lib/document-read-failure.js'

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

/**
 * Daemon only: the URL names a path the (non-empty) documents list does not
 * contain — deleted, renamed, or never existed. Rendered as an explicit
 * create-at-this-path offer; connecting anyway would mint a blank canvas
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

/**
 * Second phase, for BOTH keepers: what the CONTENT read said, once it has
 * said anything.
 *
 * Separate from each keeper's derive because the data flow is genuinely
 * two-step and pretending otherwise would be circular — the page needs a
 * document identity to open the content at all, and it gets that from the
 * first phase's `editing` state. The failure can only arrive after.
 *
 * It has to be a page-level state rather than a banner over the editor.
 * Rendering the editor for a document whose bytes are intact but unreadable
 * shows an empty canvas, and the next save overwrites them — so a user whose
 * app is merely out of date would LOSE the document by opening it. On the
 * daemon page the session binds no editor on a refused snapshot, so nothing
 * is overwritten — but a page that never read the refusal left the person on
 * the loading copy for good.
 */
export function refineForContentReadFailure<S extends { kind: string }>(
  state: S,
  failure: DocumentReadFailure | null,
): S | LoadDegradedState {
  if (failure === null || state.kind !== 'editing') return state
  return { kind: 'load-degraded', message: documentReadFailureMessage(failure) }
}
