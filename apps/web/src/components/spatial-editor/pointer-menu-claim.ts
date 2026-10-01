import { clientPointToRootLocal, type Point, screenToCanvas } from '../../lib/spatial/viewport.js'
import { getActiveMarkdownEditor } from '../markdown-editor/active-markdown-editor.js'
import { pickContentAt, pressProbes } from './element-pick.js'
import { openCommentMenuAt } from './pointer-comment-claim.js'
import type { EditorPointerInputs } from './pointer-inputs.js'

type MenuClaimInputs = Parameters<typeof openCommentMenuAt>[0] &
  Pick<
    EditorPointerInputs,
    | 'applySelection'
    | 'extraIds'
    | 'isLocked'
    | 'isOverlayEvent'
    | 'menuPickInputs'
    | 'rootRef'
    | 'selectedId'
    | 'setContextMenu'
    | 'setSelectedEdgeId'
    | 'setSelectedInkIds'
    | 'tool'
    | 'viewport'
  >

/*
 * The context menu's part in a pointer gesture: a right-click, or a
 * long-press, replacing the browser's menu with the object's own. What the
 * menu offers is `CanvasContextMenu`'s; what is decided here is what it is
 * ABOUT, and what the click selects on the way.
 */

/** A right-click on the editor. */
export function handleContextMenu(c: MenuClaimInputs, e: React.MouseEvent<HTMLDivElement>): void {
  const root = c.rootRef.current
  if (root === null) return
  // Inside a node's text editor the object is the TEXT: the menu is the
  // editing catalog (the note editor's own, Comment included), the way the
  // note editor answers a right-click on a selection.
  const editor = getActiveMarkdownEditor()
  if (
    editor !== null &&
    e.target instanceof Element &&
    e.target.closest('[data-testid="text-node-editor"]') !== null
  ) {
    e.preventDefault()
    const at = clientPointToRootLocal(e, root)
    c.setContextMenu({
      x: at.x,
      y: at.y,
      nodeId: undefined,
      edgeId: undefined,
      point: screenToCanvas(at, c.viewport),
      editor,
    })
    return
  }
  if (c.isOverlayEvent(e)) return
  e.preventDefault()
  openContextMenuAt(c, clientPointToRootLocal(e, root))
}

/** The menu for whatever is under a point on the root — a comment first. */
export function openContextMenuAt(c: MenuClaimInputs, screenPoint: Point): void {
  const point = screenToCanvas(screenPoint, c.viewport)
  if (openCommentMenuAt(c, screenPoint, point)) return
  const pick = pickContentAt(pressProbes(c.menuPickInputs), point)
  const hitId = pick?.kind === 'nodes' ? pick.id : undefined
  // An edge and a line alike: the menu builder resolves which it is out of
  // the canvas, the same way the selection does.
  const hitPathId = pick !== undefined && pick.kind !== 'nodes' ? pick.id : undefined
  if (openHandModeMenuAt(c, screenPoint, point, hitId, hitPathId)) return
  settleMenuSelection(c, hitId, hitPathId)
  c.setContextMenu({ x: screenPoint.x, y: screenPoint.y, nodeId: hitId, edgeId: hitPathId, point })
}

/**
 * In hand mode the menu carries the ANNOTATION verbs and nothing else. Hand
 * mode keeps CONTENT out of reach — a press pans, nothing selects, nothing
 * edits — but a conversation about what is on screen is not content. The
 * click selects nothing along the way: an editing affordance surfacing
 * mid-pan was the harm, and a comment verb is not one.
 */
function openHandModeMenuAt(
  c: MenuClaimInputs,
  screenPoint: Point,
  point: Point,
  hitId: string | undefined,
  hitPathId: string | undefined,
): boolean {
  if (c.tool !== 'hand') return false
  c.setContextMenu({
    x: screenPoint.x,
    y: screenPoint.y,
    nodeId: hitId,
    edgeId: hitPathId,
    point,
    verbs: 'annotation',
  })
  return true
}

/**
 * What a right-click selects before its menu opens.
 *
 * Node and edge selection stay mutually exclusive, as on the press path:
 * Delete acts on a selected edge FIRST, so leaving the other kind selected
 * makes Delete remove the wrong thing. For both collections, a click on a
 * MEMBER keeps the whole set and leads with the clicked one, or "Group
 * selection" silently loses a member; a click on anything else replaces the
 * set, so old extras do not ride along into the menu's actions.
 */
function settleMenuSelection(
  c: MenuClaimInputs,
  hitId: string | undefined,
  hitPathId: string | undefined,
): void {
  if (hitId !== undefined && !c.isLocked(hitId)) {
    c.applySelection(
      hitId === c.selectedId || c.extraIds.has(hitId)
        ? { type: 'promote', id: hitId }
        : { type: 'set-members', ids: [hitId] },
    )
    c.setSelectedEdgeId(null)
  }
  if (hitPathId !== undefined) {
    c.setSelectedInkIds((current) =>
      current.includes(hitPathId)
        ? [hitPathId, ...current.filter((id) => id !== hitPathId)]
        : [hitPathId],
    )
    c.applySelection({ type: 'clear' })
  }
}
