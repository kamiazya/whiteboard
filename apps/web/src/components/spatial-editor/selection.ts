/**
 * The selection state machine, pure. Every transition the editor performs
 * on its multi-selection routes through `reduceSelection`, so the two
 * invariants below hold BY CONSTRUCTION instead of by per-call-site
 * discipline (the defect shape that shipped a three-node selection whose
 * drag moved two nodes):
 *
 *   I1: the primary is never inside the extras.
 *   I2: extras are non-empty only while a primary exists.
 *
 * The reducer returns the INPUT state object when a transition changes
 * nothing, so React state setters can skip no-op re-renders by identity.
 */

export interface SelectionState {
  readonly primaryId: string | null
  readonly extraIds: ReadonlySet<string>
}

export const EMPTY_SELECTION: SelectionState = { primaryId: null, extraIds: new Set() }

export type SelectionEvent =
  /** The gesture reducer resolved a press/marquee to this node (or to nothing). */
  | { type: 'set-primary'; id: string | null }
  /** A plain press on a node: a member keeps the set (an extra is promoted), a non-member collapses it. */
  | { type: 'press'; id: string }
  /** Shift-click membership toggle; toggling the primary off promotes an extra. */
  | { type: 'toggle-member'; id: string }
  /** Replace the whole selection (marquee, paste, duplicate): first id is the primary. */
  | { type: 'set-members'; ids: readonly string[] }
  /** Make this node the primary without collapsing the set (context menu on a member). */
  | { type: 'promote'; id: string }
  /** Keep the primary, drop the extras (empty-space press arms a marquee). */
  | { type: 'collapse-extras' }
  | { type: 'clear' }
  /** A lock arrived (peer/agent) for nodes that may already be selected. */
  | { type: 'drop-locked'; lockedIds: ReadonlySet<string> }
  /**
   * The canvas was replaced under the selection (undo, redo, remote edit,
   * import) and these ids went with it. Carries what VANISHED rather than
   * what survived, because a node this component created locally is
   * selected before the controlling parent has echoed it back — a
   * keep-only-what-the-new-canvas-holds rule would drop that selection
   * while the echo is still in flight.
   */
  | { type: 'drop-missing'; missingIds: ReadonlySet<string> }

/**
 * Drops every id in `ids` from the selection, promoting the first surviving
 * extra when the primary itself goes. Shared by the two reasons a node stops
 * being selectable — it was locked, or it stopped existing — so both answer
 * with one set of semantics instead of two that can drift.
 */
function dropIds(state: SelectionState, ids: ReadonlySet<string>): SelectionState {
  const surviving = [...state.extraIds].filter((id) => !ids.has(id))
  const primaryDropped = state.primaryId !== null && ids.has(state.primaryId)
  if (!primaryDropped) {
    return surviving.length === state.extraIds.size
      ? state
      : { primaryId: state.primaryId, extraIds: new Set(surviving) }
  }
  const [promoted, ...rest] = surviving
  return { primaryId: promoted ?? null, extraIds: new Set(rest) }
}

/** The pressed extra becomes primary; the old primary joins the extras. */
function promoteExtra(state: SelectionState, id: string): SelectionState {
  const extras = new Set(state.extraIds)
  extras.delete(id)
  if (state.primaryId !== null && state.primaryId !== id) extras.add(state.primaryId)
  return { primaryId: id, extraIds: extras }
}

export function reduceSelection(state: SelectionState, event: SelectionEvent): SelectionState {
  switch (event.type) {
    case 'set-primary': {
      if (event.id === null) {
        return state.primaryId === null && state.extraIds.size === 0 ? state : EMPTY_SELECTION
      }
      if (event.id === state.primaryId && !state.extraIds.has(event.id)) return state
      const extras = new Set(state.extraIds)
      extras.delete(event.id)
      return { primaryId: event.id, extraIds: extras }
    }
    case 'press': {
      if (event.id === state.primaryId) return state
      if (state.extraIds.has(event.id)) return promoteExtra(state, event.id)
      return state.extraIds.size === 0 ? state : { primaryId: state.primaryId, extraIds: new Set() }
    }
    case 'toggle-member': {
      if (state.primaryId === null) return { primaryId: event.id, extraIds: state.extraIds }
      if (event.id === state.primaryId) {
        const [next, ...rest] = [...state.extraIds]
        return { primaryId: next ?? null, extraIds: new Set(rest) }
      }
      const extras = new Set(state.extraIds)
      if (extras.has(event.id)) extras.delete(event.id)
      else extras.add(event.id)
      return { primaryId: state.primaryId, extraIds: extras }
    }
    case 'set-members': {
      // Deduped defensively: a duplicated first id would otherwise sit as
      // both primary and extra, violating I1 — the reducer is the invariant
      // guarantor, not its callers.
      const [primary, ...rest] = [...new Set(event.ids)]
      return { primaryId: primary ?? null, extraIds: new Set(rest) }
    }
    case 'promote': {
      if (state.extraIds.has(event.id)) return promoteExtra(state, event.id)
      if (event.id === state.primaryId) return state
      return { primaryId: event.id, extraIds: state.extraIds }
    }
    case 'collapse-extras':
      return state.extraIds.size === 0 ? state : { primaryId: state.primaryId, extraIds: new Set() }
    case 'clear':
      return state.primaryId === null && state.extraIds.size === 0 ? state : EMPTY_SELECTION
    case 'drop-locked':
      return dropIds(state, event.lockedIds)
    case 'drop-missing':
      return dropIds(state, event.missingIds)
  }
}

/** Every selected id, primary first — the order batch commands consume. */
export function selectionMembers(state: SelectionState): string[] {
  return state.primaryId === null ? [] : [state.primaryId, ...state.extraIds]
}
