// Page-state derivation for `DaemonDocumentPage` — the daemon half of the
// shared machine in document-page-state.ts, mirroring browser-page-state.ts.
//
// The cascade used to live as an inline JSX ternary chain, where its order
// carried invariants nothing stated:
//
//   - `loading` beats everything, `loadError` included: mid-resolve, no
//     other field is trustworthy yet (the controller sets loadError and
//     then flips loading off in the same commit, but the derive must not
//     depend on that batching).
//   - `document-missing` requires a RESOLVED identity and a NON-EMPTY list.
//     An empty list answers for every path — the workspace is empty no
//     matter what the URL asked for, and the empty state's create derives a
//     fresh path rather than reusing the stale one.
//   - An unresolved identity with a non-empty list falls through to
//     `editing` (the 'no-canvas' editor). The controller's own resolution
//     always selects documents[0] so this cell is unreachable today; kept
//     as editing so a future direct-set path degrades to an idle editor
//     rather than a wrong "missing" claim about no path at all.

import type {
  DocumentMissingState,
  EditingState,
  LoadDegradedState,
  LoadingState,
  WorkspaceEmptyState,
} from './document-page-state.js'

/** The daemon refused the resolve/document read on membership grounds
 *  (ADR-0041/0042 S8) — read from `DaemonApiError.body` through
 *  `membershipRefusal`, never from a controller-field guess. */
export interface DaemonMembershipRefusal {
  code: 'requires_person_session' | 'not_a_member'
  workspaceId: string
}

export interface DaemonPageStateInput {
  loading: boolean
  loadError: string | null
  /** The selected (workspaceId, path) identity — null while unresolved. */
  canvas: { workspaceId: string; path: string } | null
  documentCount: number
  /**
   * Whether the documents list holds a tree-served entry at the selected
   * path (the page's `workspaceSyncDocumentId !== undefined`).
   */
  documentAtPath: boolean
  refusal: DaemonMembershipRefusal | null
}

/**
 * Daemon only: the resolve or document read was refused on membership
 * grounds. Declared here rather than in the shared `document-page-state.ts`
 * — the browser keeper has no membership.
 */
export interface MembershipRefusedState {
  kind: 'membership-refused'
  code: DaemonMembershipRefusal['code']
  workspaceId: string
}

export type DaemonPageState =
  | LoadingState
  | MembershipRefusedState
  | LoadDegradedState
  | DocumentMissingState
  | WorkspaceEmptyState
  | EditingState

export function deriveDaemonPageState(input: DaemonPageStateInput): DaemonPageState {
  if (input.loading) {
    return { kind: 'loading' }
  }
  if (input.refusal !== null) {
    return {
      kind: 'membership-refused',
      code: input.refusal.code,
      workspaceId: input.refusal.workspaceId,
    }
  }
  if (input.loadError !== null) {
    return { kind: 'load-degraded', message: input.loadError }
  }
  if (input.canvas !== null && input.documentCount > 0 && !input.documentAtPath) {
    return { kind: 'document-missing', path: input.canvas.path }
  }
  if (input.documentCount === 0) {
    return { kind: 'workspace-empty' }
  }
  return { kind: 'editing' }
}
