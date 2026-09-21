// What a RELEASE means, once the press has been accounted for: the three
// arms of `handlePointerUp` that are not one-liners — a band that gathered,
// a stroke that ended, and the gesture the reducer commits.
//
// Their own module because `use-editor-pointer.ts` is over the file-size
// budget and shrink-only, so the split that makes them readable has to take
// lines OUT of it rather than add signatures inside it. Each arm returns
// void and the caller keeps its own guard, so the order of the arms — which
// is the whole control flow of a release — stays visible where it is
// decided.

import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { isFrame, nodeFile, nodeSubpath, nodeText, nodeUrl } from '@kamiazya/whiteboard-model'
import { hitTest } from '../../lib/spatial/geometry.js'
import { strokeBounds } from '../../lib/spatial/stroke-group.js'
import type { Point } from '../../lib/spatial/viewport.js'
import { screenToCanvas } from '../../lib/spatial/viewport.js'
import { bandProbes, pickContentWithin } from './element-pick.js'
import { snapGesturePoint } from './gesture-snap.js'
import { carriedByGesture } from './gesture-view.js'
import type { GestureResult } from './gestures.js'
import { reduceGesture } from './gestures.js'
import { withGroupMates } from './ink-hit.js'
import type { EditorPointerInputs } from './use-editor-pointer.js'

/**
 * Everything the arms read, built once per release by the caller.
 *
 * Every field is typed FROM the hook's own input contract, so the two
 * cannot drift: an input that changes shape changes here in the same
 * compile.
 */
export interface PointerReleaseContext {
  readonly applyResult: EditorPointerInputs['applyResult']
  readonly applySelection: EditorPointerInputs['applySelection']
  readonly boxes: EditorPointerInputs['boxes']
  readonly canvas: EditorPointerInputs['canvas']
  readonly canvasRef: EditorPointerInputs['canvasRef']
  readonly createId: EditorPointerInputs['createId']
  readonly createNodeAt: EditorPointerInputs['createNodeAt']
  readonly extraIds: EditorPointerInputs['extraIds']
  readonly gestureState: EditorPointerInputs['gestureState']
  readonly gestureStateRef: EditorPointerInputs['gestureStateRef']
  readonly isImageFileRef: EditorPointerInputs['isImageFileRef']
  readonly isLocked: EditorPointerInputs['isLocked']
  readonly lastPressRef: EditorPointerInputs['lastPressRef']
  readonly lastStrokeRef: EditorPointerInputs['lastStrokeRef']
  readonly marquee: EditorPointerInputs['marquee']
  readonly missingFileRef: EditorPointerInputs['missingFileRef']
  readonly onOpenFileRef: EditorPointerInputs['onOpenFileRef']
  readonly openLinkNode: EditorPointerInputs['openLinkNode']
  readonly pasteClipboard: EditorPointerInputs['pasteClipboard']
  readonly pendingCut: EditorPointerInputs['pendingCut']
  readonly pickInputs: EditorPointerInputs['pickInputs']
  readonly selectableBoxes: EditorPointerInputs['selectableBoxes']
  readonly selectedEdgeId: EditorPointerInputs['selectedEdgeId']
  readonly setEdgeLabelEditId: EditorPointerInputs['setEdgeLabelEditId']
  readonly setGroupLabelEditId: EditorPointerInputs['setGroupLabelEditId']
  readonly setMarquee: EditorPointerInputs['setMarquee']
  readonly setSelectedInkIds: EditorPointerInputs['setSelectedInkIds']
  readonly viewport: EditorPointerInputs['viewport']
}

/**
 * A band that was drawn, or a stationary empty press that was not: the
 * zero-move case is where a double press mints a node and a pending cut is
 * answered by a tap.
 */
export function releaseMarquee(
  e: React.PointerEvent<HTMLDivElement>,
  root: HTMLElement | null,
  armed: { readonly key: string; readonly point: Point } | null,
  /** Narrowed by the caller's own guard, which is where the arm is chosen. */
  marquee: NonNullable<EditorPointerInputs['marquee']>,
  ctx: PointerReleaseContext,
): void {
  const {
    applySelection,
    canvas,
    createNodeAt,
    lastPressRef,
    pasteClipboard,
    pendingCut,
    pickInputs,
    selectedEdgeId,
    setEdgeLabelEditId,
    setMarquee,
    setSelectedInkIds,
  } = ctx
  setMarquee(null)
  const zeroMove = marquee.start.x === marquee.current.x && marquee.start.y === marquee.current.y
  if (zeroMove) {
    // A stationary empty press: a plain one just cleared selection at
    // the press; a DOUBLE one creates a node here (resolved at the
    // release, consistent with the node-edit double-press rule).
    if (armed !== null && armed.key === 'empty') createNodeAt(armed.point)
    // Tap-to-place (touch only): while a cut is pending, a stationary
    // empty tap answers it HERE — one tap instead of long-press →
    // menu → Paste here. Mice keep the explicit paste: an empty click
    // is the deselect reflex, and hijacking it would misplace nodes.
    // A tap that landed on an EDGE also starts a marquee (the press
    // handler selects the edge and falls through here), so truly
    // empty means no edge got selected — an edge tap keeps its normal
    // meaning, and the hold survives it like any other interaction.
    // Resetting the press memory keeps the NEXT tap from reading as a
    // double press (which would also mint a note at the same spot).
    else if (e.pointerType === 'touch' && pendingCut !== null && selectedEdgeId === null) {
      lastPressRef.current = null
      pasteClipboard(marquee.start)
    }
    // Double press ON an edge line edits the OBJECT under the pointer
    // (the label), mirroring the node double-press-edits rule; node
    // creation stays the empty-space double press above.
    if (armed?.key.startsWith('edge:')) {
      setEdgeLabelEditId(armed.key.slice('edge:'.length))
    }
    // An edge selected at this press has no focusable element of its
    // own (node shapes carry tabIndex; edge polylines do not), so
    // without an explicit focus the real keyboard's Delete/Escape
    // would land on <body> and never reach this root's onKeyDown.
    // Focus here at the RELEASE: the browser's default mousedown
    // focus handling runs after the pointerdown listener and undoes
    // a focus taken there.
    if (selectedEdgeId !== null) root?.focus()
    return
  }
  const rect = {
    x: Math.min(marquee.start.x, marquee.current.x),
    y: Math.min(marquee.start.y, marquee.current.y),
    w: Math.abs(marquee.current.x - marquee.start.x),
    h: Math.abs(marquee.current.y - marquee.start.y),
  }
  // What the band gathers, asked of every kind the model holds rather
  // than of the two this gesture happened to know about. It looked at
  // boxes ONLY until a person dragged over a scribble and selected
  // nothing — and a scribble is exactly what a band is for, since ink
  // arrives several strokes at a time.
  const gathered = pickContentWithin(bandProbes(pickInputs), rect)
  applySelection({ type: 'set-members', ids: [...gathered.nodes] })
  // The press-time single selection is REPLACED rather than kept: a
  // drag that began on a stroke was a marquee, and the band's own
  // answer is the whole answer. Ink and edges land in the one path
  // selection they share.
  setSelectedInkIds(withGroupMates([...gathered.lines, ...gathered.edges], canvas.lines))
  return
}

/**
 * A stroke that ended. Unsnapped like its samples: the ink ends where the
 * hand stopped.
 */
export function releaseDrawing(
  e: React.PointerEvent<HTMLDivElement>,
  screenPoint: Point,
  /** Narrowed by the caller's guard: the stroke this release ends. */
  drawn: Extract<EditorPointerInputs['gestureState'], { kind: 'drawing' }>,
  ctx: PointerReleaseContext,
): void {
  const { applyResult, canvasRef, createId, gestureStateRef, lastStrokeRef, viewport } = ctx
  const released = screenToCanvas(screenPoint, viewport)
  const bounds = strokeBounds([...drawn.points, released])
  applyResult(
    reduceGesture(
      gestureStateRef.current,
      canvasRef.current,
      { type: 'pointerup', point: released },
      { createId },
    ),
  )
  // What the next press is judged against. Recorded even when the
  // stroke was too short to mint anything: a tap between two strokes
  // of one character is part of writing it, and forgetting the mark
  // there would split it in two.
  lastStrokeRef.current =
    drawn.group === undefined || bounds === undefined
      ? null
      : { group: drawn.group, endedAt: e.timeStamp, bounds }
  return
}

/**
 * The release nothing above claimed: the reducer commits it, a double
 * press on a node that never moved opens its editor instead, and a move on
 * a multi-selection member carries the rest with it.
 */
/**
 * A double press on a node that never moved runs the object's PRIMARY action.
 *
 * Each arm asks what the node HOLDS rather than narrowing on the stored
 * discriminant: text edits, a link or a followable file reference navigates,
 * a frame edits its label — the frame's one own datum. An image reference is
 * NOT followable, because navigating to an asset id is a dead end.
 *
 * Answers false for a node that is gone or holds none of those, so the caller
 * falls through to the ordinary commit exactly as it always did.
 */
function runPrimaryAction(
  node: SpatialNode | undefined,
  result: GestureResult,
  ctx: PointerReleaseContext,
): boolean {
  if (node === undefined) return false
  const {
    applyResult,
    canvas,
    isImageFileRef,
    missingFileRef,
    onOpenFileRef,
    openLinkNode,
    setGroupLabelEditId,
  } = ctx
  const text = nodeText(node)
  if (text !== undefined) {
    applyResult(
      reduceGesture(result.state, canvas, { type: 'start-text-edit', nodeId: node.id, text }),
    )
    return true
  }
  if (nodeUrl(node) !== undefined) {
    applyResult(result)
    openLinkNode(node)
    return true
  }
  if (isFrame(node)) {
    applyResult(result)
    setGroupLabelEditId(node.id)
    return true
  }
  const file = nodeFile(node)
  if (
    file !== undefined &&
    onOpenFileRef !== undefined &&
    isImageFileRef?.(file) !== true &&
    missingFileRef?.(file) !== true
  ) {
    applyResult(result)
    onOpenFileRef(file, nodeSubpath(node))
    return true
  }
  return false
}

export function commitRelease(
  e: React.PointerEvent<HTMLDivElement>,
  screenPoint: Point,
  armed: { readonly key: string; readonly point: Point } | null,
  ctx: PointerReleaseContext,
): void {
  const {
    applyResult,
    boxes,
    canvas,
    canvasRef,
    createId,
    extraIds,
    gestureState,
    isLocked,
    selectableBoxes,
    viewport,
  } = ctx
  // Snapped with the same helper the preview used, so the box commits
  // exactly where the last frame drew it.
  const point = snapGesturePoint(screenToCanvas(screenPoint, viewport), e.metaKey || e.ctrlKey, {
    gestureState,
    canvas,
    boxes,
    extraIds,
    isLocked,
    zoom: viewport.zoom,
  }).point
  const targetNodeId =
    gestureState.kind === 'connecting' || gestureState.kind === 'reattaching'
      ? hitTest(selectableBoxes, point)
      : undefined
  const result = reduceGesture(
    gestureState,
    canvas,
    { type: 'pointerup', point, targetNodeId },
    { createId },
  )
  // A move commit on a multi-selection member applies the SAME delta to
  // every other member — expanded here at commit time so the reducer
  // keeps its single-node contract.
  // A double press on a node that never moved is double-click-to-edit.
  if (
    armed !== null &&
    gestureState.kind === 'moving' &&
    armed.key === gestureState.nodeId &&
    result.commands.length === 0 &&
    runPrimaryAction(
      canvasRef.current.nodes.find((n) => n.id === gestureState.nodeId),
      result,
      ctx,
    )
  ) {
    return
  }
  const moved = result.commands.find((c) => c.kind === 'move-node')
  if (moved !== undefined && gestureState.kind === 'moving') {
    const dx = moved.x - gestureState.startX
    const dy = moved.y - gestureState.startY
    // The SAME carried set the drag preview showed: selection extras
    // plus a grabbed group frame's geometrically contained members
    // (minus locked ones). Going through `carriedByGesture` — the one
    // producer the ghost, snapping, and the live layers already share —
    // is what makes "what you saw travelling is what the commit moves"
    // structural rather than two hand-kept copies of the containment
    // rule.
    const followerMoves = [...carriedByGesture(canvasRef.current, gestureState, extraIds, isLocked)]
      .filter((id) => id !== moved.id)
      .flatMap((id) => {
        const node = canvasRef.current.nodes.find((n) => n.id === id)
        return node === undefined
          ? []
          : [{ kind: 'move-node' as const, id, x: node.x + dx, y: node.y + dy }]
      })
    if (followerMoves.length > 0) {
      applyResult({ ...result, commands: [...result.commands, ...followerMoves] })
      return
    }
  }
  applyResult(result)
}
