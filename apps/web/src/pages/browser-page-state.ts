// Page-state derivation for `BrowserDocumentPage`.
//
// `useBrowserDocumentController` carries several flat fields that
// the page used to chain into a 3-way `if` cascade (degraded-load /
// cleanup-completed / loading / editing). The cascade order matters
// — completion view must beat the load-time placeholder — and the
// invariants between fields are not obvious from the JSX alone:
//
//   - load-degraded with a non-null snapshot still uses the editor
//     (the editor handles `persistence: degraded` itself); the
//     full-page degraded banner only fires when the load itself
//     failed and the page therefore has no snapshot to render.
//   - cleanup-completed wins over the loading placeholder because
//     `setSnapshot(null)` after a successful delete deliberately
//     drops the snapshot and the initial load effect won't re-run.
//   - cleanup-completed is mutually exclusive with load-degraded:
//     cleanup runs from the editor, so the load already succeeded
//     by the time cleanup is reachable.
//
// Encoding the cascade once as a discriminated union keeps the
// invariants grep-friendly and lets the helper be tested in isolation
// (no React renderer required).

import {
  type DocumentReadFailure,
  documentReadFailureMessage,
  documentReadUnavailableMessage,
} from '../lib/document-read-failure.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import type {
  CleanupCompletedState,
  EditingState,
  LoadDegradedState,
  LoadingState,
} from './document-page-state.js'
import type { BrowserPersistenceState } from './use-browser-document-controller.js'

export interface BrowserPageStateInput {
  snapshot: DocumentSnapshot | null
  persistence: BrowserPersistenceState
  cleanupCompleted: boolean
}

// The browser half of the shared machine in document-page-state.ts, composed
// from its state shapes:
//
// - load-degraded: the persisted canvas could not be parsed and there is no
//   user-meaningful snapshot to render. `message` is carried verbatim from
//   the persistence state so the page never has to re-narrow
//   `persistence.kind === 'degraded'` to read it — the helper is the single
//   render source of truth.
// - cleanup-completed: the persisted canvas is gone and the load effect
//   won't re-run; the page renders the completion view instead of falling
//   through to the loading placeholder.
// - loading: pre-load tick — snapshot has not arrived yet and no terminal
//   state has fired.
// - editing: steady state. `persistence` may be `saved`, `pending`,
//   `saving`, or `degraded` — that distinction is the header save-status
//   surface, not a page-level branch.
export interface LoadUnavailableState {
  readonly kind: 'load-unavailable'
  readonly message: string
}

export type BrowserPageState =
  | LoadUnavailableState
  | LoadDegradedState
  | CleanupCompletedState
  | LoadingState
  | (EditingState & { snapshot: DocumentSnapshot; persistence: BrowserPersistenceState })

export function derivePageState(input: BrowserPageStateInput): BrowserPageState {
  // Cascade order encodes the invariants documented at the top of
  // this file. Re-ordering is a deliberate ack: each clause leans
  // on the negations of the clauses above it.
  if (input.snapshot === null && input.persistence.kind === 'degraded') {
    return { kind: 'load-degraded', message: input.persistence.message }
  }
  if (input.snapshot === null && input.cleanupCompleted) {
    return { kind: 'cleanup-completed' }
  }
  if (input.snapshot === null) {
    return { kind: 'loading' }
  }
  return { kind: 'editing', snapshot: input.snapshot, persistence: input.persistence }
}

/**
 * Second phase: what the CONTENT read said, once it has said anything.
 *
 * Separate from `derivePageState` because the data flow is genuinely two-step
 * and pretending otherwise would be circular — the page needs a documentId to
 * open the content at all, and it gets that from the first phase's `editing`
 * state. The failure can only arrive after.
 *
 * It has to be a page-level state rather than a banner over the editor.
 * Rendering the editor for a document whose bytes are intact but unreadable
 * shows an empty canvas, and the next save overwrites them — so a user whose
 * app is merely out of date would LOSE the document by opening it.
 */
export function refineForContentReadFailure(
  state: BrowserPageState,
  failure: DocumentReadFailure | null,
): BrowserPageState {
  if (failure === null || state.kind !== 'editing') return state
  return { kind: 'load-degraded', message: documentReadFailureMessage(failure) }
}

/**
 * The same refusal to render the editor, for a failure that says nothing
 * about the stored bytes.
 *
 * Kept a separate state rather than a flag on `load-degraded` because the two
 * differ in the only way that matters to the reader: what they are offered.
 * `load-degraded` offers to discard the document, which is a coherent answer
 * to "these bytes cannot be read" and the wrong answer to "the read did not
 * happen". The editor still must not render — an empty canvas over intact
 * bytes is how the next save destroys them, which is this file's standing
 * reason for a page-level state.
 */
export function refineForUnavailableRead(
  state: BrowserPageState,
  unavailable: boolean,
): BrowserPageState {
  if (!unavailable || state.kind !== 'editing') return state
  return { kind: 'load-unavailable', message: documentReadUnavailableMessage() }
}
