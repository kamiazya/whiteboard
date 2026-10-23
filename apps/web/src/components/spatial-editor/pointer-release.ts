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
import { isFrame, nodeFile, nodeText, nodeUrl } from '@kamiazya/whiteboard-model'
import { frameTitleAt, pointInsideFrame } from '../../lib/spatial/frame-interior.js'
import { hitTest } from '../../lib/spatial/geometry.js'
import { strokeBounds } from '../../lib/spatial/stroke-group.js'
import type { Point } from '../../lib/spatial/viewport.js'
import { screenToCanvas } from '../../lib/spatial/viewport.js'
import { bandProbes, pickContentWithin } from './element-pick.js'
import { snapGesturePoint } from './gesture-snap.js'
import { carriedByGesture } from './gesture-view.js'
import type { GestureResult } from './gestures.js'
import { NEW_NODE_HEIGHT, NEW_NODE_WIDTH, reduceGesture } from './gestures.js'
import { withGroupMates } from './ink-hit.js'
import type { EditorPointerInputs } from './pointer-inputs.js'

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
  readonly onOpenDocument: EditorPointerInputs['onOpenDocument']
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

const INTERACTIVE =
  'button, a[href], input, textarea, select, [role="button"], [contenteditable="true"]'

/**
 * Gives the editor root keyboard focus after a press selected something.
 * Node shapes carry no tabIndex, so without it the selection shortcuts
 * (Delete, nudges, duplicate, lock, zoom) would land on <body>. It happens at
 * the RELEASE because the browser's default mousedown focus handling runs
 * after the pointerdown listener and undoes a focus taken there. A text
 * editor (or any other editable) the press opened keeps its focus.
 */
function focusRootUnlessEditing(root: HTMLElement, target: EventTarget): void {
  // A press on a control inside the root (a dock button, a card action) is
  // that control's gesture: it opens its own surface and decides where focus
  // goes, and a surface remembers the focused element to return to on close.
  // Taking focus here would make the root that element.
  if (target instanceof Element && target !== root && target.closest(INTERACTIVE) !== null) return
  const active = document.activeElement
  if (
    active instanceof HTMLElement &&
    root.contains(active) &&
    active !== root &&
    // A menu a long press opened mid-gesture owns focus past the release.
    (active.isContentEditable ||
      active.matches('input, textarea, select') ||
      active.closest('[data-context-menu]') !== null)
  ) {
    return
  }
  root.focus({ preventScroll: true })
}

/**
 * A double press on paper nothing else claimed: on a frame's name strip it
 * edits the name, anywhere else it adds a note there.
 */
function emptyDoublePress(at: Point, ctx: PointerReleaseContext): void {
  const frameId = frameTitleAt(ctx.canvasRef.current.nodes, at)
  if (frameId !== undefined) ctx.setGroupLabelEditId(frameId)
  else ctx.createNodeAt(at)
}

/** How far a hand-tool press may travel and still be a click rather than a pan. */
const HAND_CLICK_SLOP_PX = 10

/**
 * The double press the hand tool resolves at its release, when the pointer
 * stayed put (a drag is a pan, not a second click). The press itself only
 * panned, so nothing was selected: each target gets the verb it has under the
 * select tool and no more.
 */
export function releaseHandDoublePress(
  pending: { current: { key: string; point: Point; screen: Point } | null },
  screenPoint: Point,
  ctx: PointerReleaseContext,
): void {
  const armed = pending.current
  pending.current = null
  if (armed === null) return
  if (
    Math.hypot(screenPoint.x - armed.screen.x, screenPoint.y - armed.screen.y) > HAND_CLICK_SLOP_PX
  ) {
    return
  }
  if (armed.key === 'empty') {
    emptyDoublePress(armed.point, ctx)
    return
  }
  if (armed.key.startsWith('edge:')) {
    ctx.setEdgeLabelEditId(armed.key.slice('edge:'.length))
    return
  }
  const node = ctx.canvasRef.current.nodes.find((n) => n.id === armed.key)
  if (node === undefined) return
  ctx.applySelection({ type: 'set-primary', id: node.id })
  runPrimaryAction(node, { state: ctx.gestureState, commands: [] }, armed.point, ctx)
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
    if (armed !== null && armed.key === 'empty') emptyDoublePress(armed.point, ctx)
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
  at: Point,
  ctx: PointerReleaseContext,
): boolean {
  if (node === undefined) return false
  const {
    applyResult,
    canvas,
    createNodeAt,
    isImageFileRef,
    missingFileRef,
    onOpenDocument,
    openLinkNode,
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
    // A frame's interior is paper that belongs to it: the name is edited from
    // its own strip (`emptyDoublePress`), and a double press here adds a note.
    createNodeAt(pointInsideFrame(node, at, { width: NEW_NODE_WIDTH, height: NEW_NODE_HEIGHT }))
    return true
  }
  const file = nodeFile(node)
  if (
    file !== undefined &&
    onOpenDocument !== undefined &&
    isImageFileRef?.(file) !== true &&
    missingFileRef?.(file) !== true
  ) {
    applyResult(result)
    onOpenDocument(file)
    return true
  }
  return false
}

/**
 * The release nothing above claimed: the reducer commits it, a double
 * press on a node that never moved opens its editor instead, and a move on
 * a multi-selection member carries the rest with it.
 */
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
      armed.point,
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
      focusRootUnlessEditing(e.currentTarget, e.target)
      return
    }
  }
  applyResult(result)
  focusRootUnlessEditing(e.currentTarget, e.target)
}
