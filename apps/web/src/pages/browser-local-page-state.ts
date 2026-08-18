// Page-state derivation for `BrowserLocalDocumentPage`.
//
// `useBrowserLocalDocumentController` carries several flat fields that
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

import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import type { BrowserLocalPersistenceState } from './use-browser-local-document-controller.js'

export interface BrowserLocalPageStateInput {
  snapshot: DocumentSnapshot | null
  persistence: BrowserLocalPersistenceState
  cleanupCompleted: boolean
}

export type BrowserLocalPageState =
  // The persisted canvas could not be parsed and there is no
  // user-meaningful snapshot to render. The page renders the
  // full-page degraded banner; recovery affordances live there.
  // `message` is carried verbatim from the persistence state so the
  // page never has to re-narrow `persistence.kind === 'degraded'`
  // to read it — the helper is the single render source of truth.
  | { kind: 'load-degraded'; message: string }
  // The user just deleted the retained browser copy. The persisted
  // canvas is gone and the load effect won't re-run; the page
  // renders the completion view instead of falling through to the
  // loading placeholder.
  | { kind: 'cleanup-completed' }
  // Pre-load tick: snapshot has not arrived yet and no terminal
  // state (degraded / cleanup-completed) has fired. The page
  // renders the loading placeholder.
  | { kind: 'loading' }
  // Steady state. The editor renders. `persistence` may be `saved`,
  // `pending`, `saving`, or `degraded` — that distinction is the
  // header save-status surface, not a page-level branch.
  | { kind: 'editing'; snapshot: DocumentSnapshot; persistence: BrowserLocalPersistenceState }

export function derivePageState(input: BrowserLocalPageStateInput): BrowserLocalPageState {
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
