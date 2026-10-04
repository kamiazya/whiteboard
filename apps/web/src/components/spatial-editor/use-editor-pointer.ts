// The editor's POINTER surface, extracted from SpatialEditor as one hook:
// the six handlers the JSX wires — press, context menu, move, release,
// cancel and lost capture. Everything here CONSUMES the editor's state and
// appliers; it owns no React state of its own, so a pointer behaviour can
// never disagree with the keyboard path about whose state is authoritative.
//
// Its own module for the reason `use-editor-keyboard.ts` is one, and
// because `SpatialEditor.tsx` sits at its `file-size-budget` ceiling: that
// file cannot be improved in place at all, so its two remaining surfaces
// have to leave it one at a time. The keyboard went first.

/**
 * A read-write editor for a `SpatialCanvas`, built on canvas-render's
 * `layoutSpatialCanvas` + `renderSceneToSvg` (the same scene builder
 * canvas-viewer's read-only `CanvasViewer` uses — this is NOT a fourth
 * scene builder).
 *
 * Supported: display, pan, zoom (wheel / Space-drag / middle-drag on
 * desktop; two-finger drag pans and pinch zooms on touch — one finger
 * keeps the select/move semantics), select (click / click-empty-to-clear),
 * move (drag a selected node), resize (drag a corner/edge handle,
 * anchor-preserving, OR arrow-key nudge a focused resize handle), edit
 * text (double-click a text node; commits on blur/Cmd+Enter, Escape
 * cancels), connect an edge (drag from a selected node's connect handle
 * onto another node, OR Enter/Space the connect handle then Tab to a
 * target node's connect-target control and Enter/Space it; Escape cancels
 * an in-flight gesture from the keyboard too), create a node (double-click
 * empty canvas space, or the keyboard-reachable "+" menu's Note entry — both
 * open the new node for typing immediately), delete the current
 * selection (Delete/Backspace, disabled while its text editor is open so
 * Backspace-while-typing edits text instead of deleting the node), select
 * an edge (click its line) and delete it (Delete/Backspace), and edit an
 * edge's label (double-click its line; commits on blur, empty removes,
 * Escape cancels), and restyle an edge from its context menu (arrowhead
 * direction per JSON Canvas fromEnd/toEnd, and per-endpoint side pinning
 * with an auto option), create a link node (the palette's Link entry (URL
 * dialog), follow it (double-click, or "Open link" in its context menu —
 * opens in a new tab with noopener), rewrite its URL ("Edit URL"), create
 * a group frame (the palette's Group entry (an empty frame), or "Group
 * selection" from a multi-selected node's context menu), move a frame
 * with its geometrically contained members, edit the frame's label
 * (double-click, or "Edit label" in its context menu; empty removes),
 * and — when the host supplies the seams — create a file node referencing
 * another canvas (the palette's Document picker), follow it
 * (double-click / "Open canvas"), and retarget it ("Change target").
 *
 * The component is CONTROLLED and owns no persistence: every mutating
 * gesture calls `onChange(next, command)` with a brand-new `SpatialCanvas`
 * value (see `commands.ts`) — it never mutates the `canvas` prop.
 *
 * Also supported: the clipboard family — copy/cut/paste over the native
 * clipboard events (fragment JSON in `text/plain`, foreign text degrading
 * to a note), duplicate (Cmd/Ctrl+D), select-all, z-order moves,
 * align/distribute over a multi-selection, and viewport framing (zoom to
 * fit / to selection). Every one has a context-menu or dock twin; every
 * binding is declared in `shortcuts.ts`.
 *
 * Dragging a node also SNAPS it to nearby neighbour edges/centres and to a
 * background grid, drawing the guide that justifies each snap; Cmd/Ctrl
 * suspends it for one gesture (`snap.ts` holds the geometry).
 *
 * Persistence and sync are the host's job, not this component's: it
 * hands every change to `onChange` and the host's document session stores
 * and syncs it.
 *
 * Freehand drawing and shape tools are not offered because they are out of
 * scope. JSON Canvas 1.0 has no shape or stroke
 * node, and a strict export drops the extension that would have carried one,
 * so anything drawn that way would lose its shape reaching another tool. A
 * diagram that needs a shape uses an image node.
 */

import { clientPointToRootLocal, type Point, screenToCanvas } from '../../lib/spatial/viewport.js'
import { pickContentAt, pressProbes, shiftPress } from './element-pick.js'
import { snapGesturePoint } from './gesture-snap.js'
import { describeTarget, gestureTrace } from './gesture-trace.js'
import { reduceGesture } from './gestures.js'
import { withGroupMates } from './ink-hit.js'
import type { PointerKind } from './navigation.js'
import { DOUBLE_PRESS_WINDOW_MS } from './navigation.js'
import {
  advanceCommentDrag,
  cancelCommentPress,
  commentHoldsPress,
  commitCommentDrag,
  dismissCommentCard,
  releaseCommentPress,
  rememberCommentPress,
  startCommentPinDrag,
} from './pointer-comment-claim.js'
import { advanceDrawing, armInkDrag, beginDrawStroke, releaseInkDrag } from './pointer-ink-claim.js'
import type { EditorPointerInputs } from './pointer-inputs.js'
import { handleContextMenu as handleMenu, openContextMenuAt } from './pointer-menu-claim.js'
import {
  cancelProposalPress,
  claimProposalBubble,
  dismissProposalCard,
  releaseProposalPress,
} from './pointer-proposal-claim.js'
import { commitRelease, releaseDrawing, releaseMarquee } from './pointer-release.js'

/**
 * The navigation machine distinguishes touch from everything else; pen
 * behaves as a mouse there, so this only has to be total, not faithful to
 * every platform's spelling.
 */
function navigationPointerKind(pointerType: string): PointerKind {
  return pointerType === 'touch' ? 'touch' : pointerType === 'pen' ? 'pen' : 'mouse'
}

const LONG_PRESS_SLOP_PX = 10

/**
 * What a press landed on, as the three answers every claimant asks for.
 *
 * `hitId` is `undefined` when INK won the pick, so a press on a stroke over
 * empty board reads as exactly that. `hitPathId` merges edges and lines,
 * because the selection state treats the two alike — `deleteInkCommand` is
 * the one place that looks at which it is. `pressKey` is what the
 * double-press pairing compares, and it distinguishes "double-click on an
 * edge" (open its label editor) from "double-click on empty space" (create a
 * node), which both have no `hitId`.
 */
function describePress(pick: ReturnType<typeof pickContentAt>): {
  hitId: string | undefined
  hitPathId: string | undefined
  pressKey: string
} {
  const hitInkId = pick?.kind === 'lines' ? pick.id : undefined
  const hitId = pick?.kind === 'nodes' ? pick.id : undefined
  const hitPathId = hitInkId ?? (pick?.kind === 'edges' ? pick.id : undefined)
  const pressKey = hitId ?? (hitPathId !== undefined ? `edge:${hitPathId}` : 'empty')
  return { hitId, hitPathId, pressKey }
}

export function useEditorPointer(inputs: EditorPointerInputs) {
  const {
    createNodeAt,
    pasteClipboard,
    openLinkNode,
    commentDrag,
    pendingCut,
    selectedEdgeId,
    selectedInkIds,
    setEdgeLabelEditId,
    setGroupLabelEditId,
    setSelectedEdgeId,
    setSelectedInkIds,
    activePointerIdRef,
    applySelection,
    canvasRef,
    clearLongPress,
    doublePressRef,
    gestureState,
    gestureStateRef,
    lastPressRef,
    longPressRef,
    marquee,
    navigationRef,
    setLivePoint,
    setMarquee,
    setSnapGuides,
    spaceDownRef,
    isLocked,
    selectableBoxes,
    boxes,
    openContextMenuAtRef,
    tool,
    viewport,
    canvas,
    createId,
    isImageFileRef,
    missingFileRef,
    onOpenFileRef,
    applyResult,
    capturePointer,
    extraIds,
    isOverlayEvent,
    lastStrokeRef,
    pickInputs,
    rootRef,
    runNavigation,
    selectedId,
    toggleSelectionMember,
  } = inputs

  /**
   * A press an overlay took. The one rejection that would otherwise leave no
   * trace at all — a dead zone made of chrome reads as nothing having happened —
   * so the recorder names what took it.
   */
  const rejectedByOverlay = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    if (!isOverlayEvent(e)) return false
    gestureTrace.recordOverlayRejected({
      at: Math.round(e.timeStamp),
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      target: describeTarget(e.target),
    })
    return true
  }

  /**
   * A press on the canvas surface shuts an open conversation or proposal
   * card, the way a pointerdown outside a menu shuts the menu.
   *
   * It is the one dismissal a phone has: there is no Escape, and each card
   * covers the bubble whose second press would otherwise toggle it. A press
   * on the open comment's own chrome (its pin, which the card leaves
   * uncovered) is left to the release, which toggles it shut as before.
   *
   * Not a claimant: it dismisses and lets the press carry on.
   */
  const dismissOpenCards = (point: Point): void => {
    dismissCommentCard(inputs, point)
    dismissProposalCard(inputs, point)
  }

  /**
   * Shift-click builds a multi-selection instead of starting a gesture.
   *
   * What it MEANS per kind is `element-pick.ts`'s: the two arms written
   * where each was first needed is how ink came to fall through the node arm
   * entirely. A kind it answers `none` for falls
   * through to the replacing paths below, carrying its reason.
   */
  const claimShiftPress = (
    e: React.PointerEvent<HTMLDivElement>,
    pick: ReturnType<typeof pickContentAt>,
  ): boolean => {
    if (!e.shiftKey) return false
    const shift = shiftPress(pick, selectedInkIds, canvas.lines, withGroupMates)
    if (shift.kind === 'nodes') {
      toggleSelectionMember(selectedId, shift.id)
      return true
    }
    if (shift.kind === 'paths') {
      setSelectedInkIds(shift.ids)
      return true
    }
    return false
  }

  /**
   * Double-press detection is OURS, not the browser's `dblclick`.
   *
   * The first press selects the node, which re-renders the DOM under the
   * pointer (selection overlay, gesture state), so the second click can land
   * on a different element instance and Chromium then never synthesises a
   * dblclick at all. Comparing node IDS within the OS-conventional window is
   * stable against those re-renders.
   */
  const recordDoublePress = (pressKey: string, at: number, screenPoint: Point, point: Point) => {
    const isDoublePress =
      lastPressRef.current !== null &&
      lastPressRef.current.key === pressKey &&
      at - lastPressRef.current.at <= DOUBLE_PRESS_WINDOW_MS
    lastPressRef.current = isDoublePress ? null : { key: pressKey, at, point: screenPoint }
    doublePressRef.current = isDoublePress ? { key: pressKey, point } : null
  }

  /**
   * A press that landed on no node: the marquee starts, unless a stroke
   * under the pointer is armed to travel instead (`armInkDrag`). A press on
   * a relation arms nothing and falls through to the band.
   */
  const pressOnEmptyBoard = (point: Point, hitPathId: string | undefined): void => {
    setMarquee({ start: point, current: point })
    applySelection({ type: 'collapse-extras' })
    if (hitPathId === undefined) {
      setSelectedEdgeId(null)
      applyResult(reduceGesture(gestureState, canvas, { type: 'pointerdown-empty' }))
      return
    }
    if (armInkDrag(inputs, point, hitPathId)) {
      setMarquee(null)
      return
    }
    applyResult(reduceGesture(gestureState, canvas, { type: 'pointerdown-empty' }))
  }

  /**
   * A press on a NODE. A plain press on a NON-member collapses the
   * multi-selection; a press on a member keeps the whole set and leads with
   * the pressed node — the reducer owns both transitions.
   *
   * Connect tool: the FIRST node press arms the connect (the same reducer arm
   * the keyboard/handle flows use). While 'connecting', a node press is
   * swallowed — the connect completes on the POINTERUP over the target, so
   * dispatching a plain pointerdown here would tear the in-flight connect
   * down first.
   */
  const pressOnNode = (hitId: string, point: Point): void => {
    applySelection({ type: 'press', id: hitId })
    setSelectedEdgeId(null)
    if (tool === 'connect') {
      if (gestureState.kind !== 'connecting') {
        applyResult(
          reduceGesture(gestureState, canvas, { type: 'pointerdown-connect', nodeId: hitId }),
        )
      }
      return
    }
    applyResult(reduceGesture(gestureState, canvas, { type: 'pointerdown', nodeId: hitId, point }))
  }

  /**
   * What navigation needs to know about the board to judge a press.
   *
   * `anchorPrimaryId` is the anchor a gather would extend: mid-gather it is
   * the standing selection, otherwise only a node this press could join to —
   * which is why entering hand mode, which clears the selection, can never
   * gather.
   */
  const pressNavigationContext = (hitId: string | undefined) => ({
    handMode: tool === 'hand',
    spaceDown: spaceDownRef.current,
    hitId,
    anchorPrimaryId:
      navigationRef.current.mode.kind === 'gathering'
        ? selectedId
        : gestureState.kind === 'moving'
          ? gestureState.nodeId
          : null,
    manipulating: gestureState.kind !== 'idle',
  })

  /**
   * Everything that floats ABOVE the document gets the press first.
   *
   * Navigation is in this half rather than the document's because in hand
   * mode it takes every plain press as a pan and never hands it back — so
   * anything a reader can still reach while panning (a comment's chrome) has
   * to be remembered before it runs, and anything it owns has to be settled
   * before the document sees anything.
   *
   * Answers true when the press is spoken for.
   */
  const chromeClaimsPress = (
    e: React.PointerEvent<HTMLDivElement>,
    root: HTMLElement,
    point: Point,
    screenPoint: Point,
    hitId: string | undefined,
  ): boolean => {
    dismissOpenCards(point)
    rememberCommentPress(inputs, e, point, screenPoint)
    // Navigation answers for its own state. Everything it owns — which finger
    // is down, whether two of them are driving the viewport, whether this
    // press continues a gather — lives in one value in `navigation.ts` rather
    // than in refs scattered through this handler.
    const navigation = runNavigation(
      root,
      {
        type: 'pointerdown',
        pointerId: e.pointerId,
        pointerType: navigationPointerKind(e.pointerType),
        isPrimary: e.isPrimary,
        button: e.button,
        point: screenPoint,
        timeStamp: e.timeStamp,
        context: pressNavigationContext(hitId),
      },
      e.timeStamp,
    )
    if (navigation.preventDefault === true) e.preventDefault()
    if (!navigation.fallThrough) return true
    if (e.button !== 0) return true
    // A comment's chrome floats above content, so a press it took never falls
    // through to node or marquee handling. There is deliberately no
    // double-press-to-edit: a single press opens the card, whose own Edit is
    // the successor, and the second press of a pair would land on that card.
    if (commentHoldsPress(inputs)) return true
    return claimProposalBubble(inputs, point, screenPoint)
  }

  /**
   * A press is offered to each claimant in PRIORITY ORDER, and the first that
   * takes it stops the chain — the same shape `handlePointerMove` below
   * already had, applied to the path that never got it.
   *
   * The order is the whole content of this function: chrome above the
   * document claims before the document does, and what each position is FOR
   * is on the claimant rather than in a comment beside a `return`.
   */
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (rejectedByOverlay(e)) return
    const root = rootRef.current
    if (root === null) return
    const screenPoint = clientPointToRootLocal(e, root)
    const point = screenToCanvas(screenPoint, viewport)
    // WHICH KIND the press lands on, decided in one place for every kind the
    // model holds (`element-pick.ts`). Three hit-tests two hundred lines
    // apart would make the priority between them a property of where each had
    // been written — and a kind nobody had written would simply never be
    // tested for.
    const pick = pickContentAt(pressProbes(pickInputs), point)
    const { hitId, hitPathId, pressKey } = describePress(pick)

    if (chromeClaimsPress(e, root, point, screenPoint, hitId)) return
    if (beginDrawStroke(inputs, e, root, point)) return
    // Deliberately NO pointer capture below. Capturing on the press retargets
    // the subsequent clicks to the capturing root, so a control the press
    // bubbled from never receives its click. Capture is taken on the first
    // real pointermove instead (`captureOnFirstMove`); overlay handle/connect
    // gestures are the exception and want it immediately.
    if (claimShiftPress(e, pick)) return

    recordDoublePress(pressKey, e.timeStamp, screenPoint, point)
    if (hitId === undefined) {
      pressOnEmptyBoard(point, hitPathId)
      return
    }
    pressOnNode(hitId, point)
  }

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => handleMenu(inputs, e)
  openContextMenuAtRef.current = (screenPoint: Point) => openContextMenuAt(inputs, screenPoint)

  /**
   * Movement past finger-jitter slop turns the press into a drag: the
   * armed long-press menu must not interrupt it.
   */
  const cancelLongPressPastSlop = (e: React.PointerEvent<HTMLDivElement>, root: HTMLElement) => {
    const armed = longPressRef.current
    if (armed === null || armed.pointerId !== e.pointerId) return
    const now = clientPointToRootLocal(e, root)
    if (Math.hypot(now.x - armed.screen.x, now.y - armed.screen.y) > LONG_PRESS_SLOP_PX) {
      clearLongPress()
    }
  }

  /**
   * First movement of an in-flight gesture: take capture now (see the
   * handlePointerDown comment for why not at the press). Idempotent —
   * re-capturing the same pointer is a no-op. Taken BEFORE the machine
   * reduces this move, so it reads the pan that the PRESS started rather
   * than the one this move is about to advance.
   */
  const captureOnFirstMove = (e: React.PointerEvent<HTMLDivElement>, root: HTMLElement) => {
    if (
      activePointerIdRef.current === null &&
      (navigationRef.current.mode.kind === 'panning' ||
        gestureState.kind !== 'idle' ||
        commentDrag !== null)
    ) {
      capturePointer(root, e.pointerId)
    }
  }

  const advanceMarquee = (screenPoint: Point): boolean => {
    if (marquee === null) return false
    setMarquee({ start: marquee.start, current: screenToCanvas(screenPoint, viewport) })
    return true
  }

  /** Every other gesture: snap the point, show the guides, reduce. */
  const advanceSnappedGesture = (
    e: React.PointerEvent<HTMLDivElement>,
    screenPoint: Point,
  ): void => {
    const snapped = snapGesturePoint(
      screenToCanvas(screenPoint, viewport),
      e.metaKey || e.ctrlKey,
      {
        gestureState,
        canvas,
        boxes,
        extraIds,
        isLocked,
        zoom: viewport.zoom,
      },
    )
    setSnapGuides(snapped.guides)
    setLivePoint(snapped.point)
    applyResult(reduceGesture(gestureState, canvas, { type: 'pointermove', point: snapped.point }))
  }

  /**
   * The steps `handlePointerMove` runs, in the order it runs them — which
   * is the semantics rather than a detail: a pointer move belongs to at
   * most one gesture, and an earlier step winning is how that is decided.
   *
   * A step leaves this scope with its CLAIMANT, not on its own: moved
   * singly, the handler's 32 closed-over values become 32 parameters, the
   * same knot with a longer signature. A claimant (`pointer-comment-claim.ts`)
   * carries its press, move and release together and takes only the inputs
   * that gesture reads. The handler below still reads as the order.
   *
   * A step that ANSWERS the move returns true; one that only has a side
   * effect returns nothing.
   */
  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (root === null) return
    cancelLongPressPastSlop(e, root)
    const screenPoint = clientPointToRootLocal(e, root)
    captureOnFirstMove(e, root)
    if (startCommentPinDrag(inputs, e, root, screenPoint)) return
    const navigation = runNavigation(
      root,
      {
        type: 'pointermove',
        pointerId: e.pointerId,
        pointerType: navigationPointerKind(e.pointerType),
        point: screenPoint,
      },
      e.timeStamp,
    )
    if (!navigation.fallThrough) return
    if (advanceCommentDrag(inputs, screenPoint)) return
    if (advanceMarquee(screenPoint)) return
    if (gestureState.kind === 'idle' && gestureStateRef.current.kind !== 'drawing') return
    if (advanceDrawing(inputs, screenPoint)) return
    advanceSnappedGesture(e, screenPoint)
  }

  const releaseContext = {
    applyResult,
    applySelection,
    boxes,
    canvas,
    canvasRef,
    createId,
    createNodeAt,
    extraIds,
    gestureState,
    gestureStateRef,
    isImageFileRef,
    isLocked,
    lastPressRef,
    lastStrokeRef,
    marquee,
    missingFileRef,
    onOpenFileRef,
    openLinkNode,
    pasteClipboard,
    pendingCut,
    pickInputs,
    selectableBoxes,
    selectedEdgeId,
    setEdgeLabelEditId,
    setGroupLabelEditId,
    setMarquee,
    setSelectedInkIds,
    viewport,
  }

  /**
   * The chrome half of the release chain, mirroring `chromeClaimsPress`.
   *
   * A release the machine answered was NAVIGATION — a finger leaving a gather
   * or a pinch, or the end of a pan. None of them run the click and marquee
   * semantics the document half holds: the sequence was never a gesture on
   * the canvas, and treating its release as one would re-collapse the very
   * selection the gather just built.
   */
  const chromeClaimsRelease = (
    e: React.PointerEvent<HTMLDivElement>,
    root: HTMLElement,
    navigationFellThrough: boolean,
  ): boolean => {
    if (releaseCommentPress(inputs)) return true
    if (releaseProposalPress(inputs, e, root)) return true
    if (!navigationFellThrough) return true
    return commitCommentDrag(inputs, e, root)
  }

  /**
   * A release is offered to each claimant in priority order, the mirror of
   * `handlePointerDown`'s chain: chrome answers before the document, and what
   * each position is FOR is on the claimant.
   */
  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (root === null) return
    const navigation = runNavigation(
      root,
      {
        type: 'pointerup',
        pointerId: e.pointerId,
        pointerType: navigationPointerKind(e.pointerType),
      },
      e.timeStamp,
    )
    if (chromeClaimsRelease(e, root, navigation.fallThrough)) return

    const armed = doublePressRef.current
    doublePressRef.current = null
    if (releaseInkDrag(inputs, e, root, armed)) return
    if (marquee !== null) {
      releaseMarquee(e, root, armed, marquee, releaseContext)
      return
    }
    const screenPoint = clientPointToRootLocal(e, root)
    // Unsnapped like its samples: the ink ends where the hand stopped.
    const drawing = gestureStateRef.current
    if (drawing.kind === 'drawing') {
      releaseDrawing(e, screenPoint, drawing, releaseContext)
      return
    }
    commitRelease(e, screenPoint, armed, releaseContext)
  }

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (root === null) return
    // The machine's own cancel arm emits the long-press clear, the capture
    // release and the gesture cancel, in that order — the three things
    // a handler would otherwise do by hand across four refs.
    runNavigation(
      root,
      {
        type: 'pointercancel',
        pointerId: e.pointerId,
        pointerType: navigationPointerKind(e.pointerType),
      },
      e.timeStamp,
    )
    // A cancelled pin drag writes nothing: the comment stays where it was,
    // and the press that armed it is spent — left set, the next unrelated
    // release would read the stale id and open that comment's card. The
    // same is true of a proposal's press.
    cancelCommentPress(inputs)
    cancelProposalPress(inputs)
  }

  /**
   * `lostpointercapture` is NOT a synonym for "the gesture broke". It also
   * fires on the ordinary release of a captured pointer — and the browser
   * captures touch pointers IMPLICITLY, so on a touch device it arrives
   * after every single tap. Cancelling there deleted the node the
   * empty-canvas double-TAP had just created for editing: it appeared and
   * vanished. (The same double-CLICK was fine — capture is taken at the
   * first MOVE, so a stationary mouse press holds none to lose.)
   *
   * The question is per-POINTER, not per-editor: is THIS pointer still
   * down? A pinch captures both fingers, so lifting one leaves the other
   * held. Deciding from any editor-wide "is something active" flag lets
   * the lifted finger's ordinary handback answer for the finger still
   * down — which then leaves the pinch bookkeeping holding a pointer id
   * nothing will ever release, silently deadening whichever later touch
   * inherits it.
   */
  const handleLostPointerCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only the ROOT losing capture is a loss. A real touch implicitly
    // captures the pointer to the element under the finger (Pointer
    // Events, "implicit pointer capture") — over a node that is an SVG
    // child, not this root — and the first move's own capturePointer()
    // then TRANSFERS capture here, which fires `lostpointercapture` on
    // that child a frame later, bubbling to this handler. Treating the
    // transfer this component itself performed as a loss cancelled the
    // pan under a still-moving finger: pressed over a node it died within
    // two frames, pressed over empty canvas (implicit capture already on
    // the root, transfer a no-op, no event) it lived. Synthetic pointer
    // events get no implicit capture, so only a real device ever showed
    // it — caught by the gesture flight recorder, not by a test.
    if (e.target !== e.currentTarget) return
    if (!navigationRef.current.down.has(e.pointerId)) return
    gestureTrace.recordLostCapture(e.pointerId, Math.round(e.timeStamp))
    handlePointerCancel(e)
  }

  return {
    handlePointerDown,
    handleContextMenu,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleLostPointerCapture,
  }
}
