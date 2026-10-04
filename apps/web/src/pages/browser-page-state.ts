// Page-state derivation for `BrowserDocumentPage`.
//
// `useBrowserDocumentController` carries several flat fields that
// a page would otherwise chain into an `if` cascade (degraded-load /
// loading / editing). The invariant between fields is not obvious
// from the JSX alone:
//
//   - load-degraded with a non-null snapshot still uses the editor
//     (the editor handles `persistence: degraded` itself); the
//     full-page degraded banner only fires when the load itself
//     failed and the page therefore has no snapshot to render.
//
// Encoding the cascade once as a discriminated union keeps the
// invariants grep-friendly and lets the helper be tested in isolation
// (no React renderer required).

import type { BrowserPersistenceState } from '../lib/browser-persistence-state.js'
import {
  type DocumentReadFailure,
  documentReadFailureMessage,
} from '../lib/document-read-failure.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import type { EditingState, LoadDegradedState, LoadingState } from './document-page-state.js'
export interface BrowserPageStateInput {
  snapshot: DocumentSnapshot | null
  persistence: BrowserPersistenceState
}

// The browser half of the shared machine in document-page-state.ts, composed
// from its state shapes:
//
// - load-degraded: the persisted canvas could not be parsed and there is no
//   user-meaningful snapshot to render. `message` is carried verbatim from
//   the persistence state so the page never has to re-narrow
//   `persistence.kind === 'degraded'` to read it — the helper is the single
//   render source of truth.
// - loading: pre-load tick — snapshot has not arrived yet and no terminal
//   state has fired.
// - editing: steady state. `persistence` may be `saved`, `pending`,
//   `saving`, or `degraded` — that distinction is the header save-status
//   surface, not a page-level branch.
export type BrowserPageState =
  | LoadDegradedState
  | LoadingState
  | (EditingState & { snapshot: DocumentSnapshot; persistence: BrowserPersistenceState })

export function derivePageState(input: BrowserPageStateInput): BrowserPageState {
  // Cascade order encodes the invariants documented at the top of
  // this file. Re-ordering is a deliberate ack: each clause leans
  // on the negations of the clauses above it.
  if (input.snapshot === null && input.persistence.kind === 'degraded') {
    return { kind: 'load-degraded', message: input.persistence.message }
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
