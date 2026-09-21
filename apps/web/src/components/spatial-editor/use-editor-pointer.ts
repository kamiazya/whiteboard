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
 * NOT yet supported (see `SPATIAL_EDITOR_UNSUPPORTED`): persistence and
 * sync. Those are later phases.
 *
 * Freehand drawing and shape tools are NOT on that list because they are not
 * deferred — they are out of scope. JSON Canvas 1.0 has no shape or stroke
 * node, and a strict export drops the extension that would have carried one,
 * so anything drawn that way would lose its shape reaching another tool. A
 * diagram that needs a shape uses an image node.
 */

import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { defaultCreateId } from '../../lib/spatial/element-id.js'
import { continuesStroke, type PreviousStroke } from '../../lib/spatial/stroke-group.js'
import { clientPointToRootLocal, type Point, screenToCanvas } from '../../lib/spatial/viewport.js'
import { getActiveMarkdownEditor } from '../markdown-editor/active-markdown-editor.js'
import type { PickInputs } from './element-pick.js'
import { pickContentAt, pressProbes, shiftPress } from './element-pick.js'
import { snapGesturePoint } from './gesture-snap.js'
import { describeTarget, gestureTrace } from './gesture-trace.js'
import type { GestureResult } from './gestures.js'
import { reduceGesture } from './gestures.js'
import { withGroupMates } from './ink-hit.js'
import type { PointerKind } from './navigation.js'
import {
  DOUBLE_PRESS_WINDOW_MS,
  type NavigationEvent,
  type NavigationResult,
} from './navigation.js'
import { commitRelease, releaseDrawing, releaseMarquee } from './pointer-release.js'
import type { SpatialEditorProps } from './SpatialEditor.js'
import type { useCommentState } from './use-comment-state.js'
import type { useEditSessionState } from './use-edit-session-state.js'
import type { useInteractionState } from './use-interaction-state.js'
import type { useLockPolicy } from './use-lock-policy.js'
import type { useNodeBoxes } from './use-node-boxes.js'
import type { useToolState } from './use-tool-state.js'
import type { useViewportControls } from './use-viewport-controls.js'

/**
 * What the pointer surface reads and writes.
 *
 * A field the component gets from a hook is typed FROM that hook
 * (`ReturnType<typeof useX>['field']`) rather than copied: a bag this
 * size hand-written drifts from its sources in silence, and the drift is
 * invisible until a behaviour depends on it. Only what the component
 * derives itself is spelled out.
 */
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
 * Screen px a press on a comment may wander before it is a pin drag rather
 * than a tap. A finger's tap is never perfectly still, and below this the
 * release opens the card instead of moving the comment by nothing.
 */
const COMMENT_PRESS_SLOP_PX = 4

/** Screen distance between two points — how far a press travelled. */
function travelled(from: Point, to: Point): number {
  return Math.hypot(from.x - to.x, from.y - to.y)
}

export interface EditorPointerInputs {
  // `useCommentState`
  readonly commentById: ReturnType<typeof useCommentState>['commentById']
  readonly commentDrag: ReturnType<typeof useCommentState>['commentDrag']
  readonly commentPlacementObstacles: ReturnType<
    typeof useCommentState
  >['commentPlacementObstacles']
  readonly hitTestComment: ReturnType<typeof useCommentState>['hitTestComment']
  readonly openCommentId: ReturnType<typeof useCommentState>['openCommentId']
  readonly pressedCommentRef: ReturnType<typeof useCommentState>['pressedCommentRef']
  readonly setCommentDrag: ReturnType<typeof useCommentState>['setCommentDrag']
  readonly setOpenCommentId: ReturnType<typeof useCommentState>['setOpenCommentId']
  readonly toggleCommentCard: ReturnType<typeof useCommentState>['toggleCommentCard']
  // `useEditSessionState`
  readonly pendingCut: ReturnType<typeof useEditSessionState>['pendingCut']
  readonly selectedEdgeId: ReturnType<typeof useEditSessionState>['selectedEdgeId']
  readonly selectedInkIds: ReturnType<typeof useEditSessionState>['selectedInkIds']
  readonly setEdgeLabelEditId: ReturnType<typeof useEditSessionState>['setEdgeLabelEditId']
  readonly setGroupLabelEditId: ReturnType<typeof useEditSessionState>['setGroupLabelEditId']
  readonly setSelectedEdgeId: ReturnType<typeof useEditSessionState>['setSelectedEdgeId']
  readonly setSelectedInkIds: ReturnType<typeof useEditSessionState>['setSelectedInkIds']
  // `useInteractionState`
  readonly activePointerIdRef: ReturnType<typeof useInteractionState>['activePointerIdRef']
  readonly applySelection: ReturnType<typeof useInteractionState>['applySelection']
  readonly canvasRef: ReturnType<typeof useInteractionState>['canvasRef']
  readonly clearLongPress: ReturnType<typeof useInteractionState>['clearLongPress']
  readonly doublePressRef: ReturnType<typeof useInteractionState>['doublePressRef']
  readonly gestureState: ReturnType<typeof useInteractionState>['gestureState']
  readonly gestureStateRef: ReturnType<typeof useInteractionState>['gestureStateRef']
  readonly lastPressRef: ReturnType<typeof useInteractionState>['lastPressRef']
  readonly longPressRef: ReturnType<typeof useInteractionState>['longPressRef']
  readonly marquee: ReturnType<typeof useInteractionState>['marquee']
  readonly navigationRef: ReturnType<typeof useInteractionState>['navigationRef']
  readonly setLivePoint: ReturnType<typeof useInteractionState>['setLivePoint']
  readonly setMarquee: ReturnType<typeof useInteractionState>['setMarquee']
  readonly setSnapGuides: ReturnType<typeof useInteractionState>['setSnapGuides']
  readonly spaceDownRef: ReturnType<typeof useInteractionState>['spaceDownRef']
  // `useLockPolicy`
  readonly isLocked: ReturnType<typeof useLockPolicy>['isLocked']
  readonly selectableBoxes: ReturnType<typeof useLockPolicy>['selectableBoxes']
  // `useNodeBoxes`
  readonly boxes: ReturnType<typeof useNodeBoxes>['boxes']
  // `useToolState`
  readonly openContextMenuAtRef: ReturnType<typeof useToolState>['openContextMenuAtRef']
  readonly setContextMenu: ReturnType<typeof useToolState>['setContextMenu']
  readonly tool: ReturnType<typeof useToolState>['tool']
  // `useViewportControls`
  readonly viewport: ReturnType<typeof useViewportControls>['viewport']
  // the editor’s own props
  readonly canvas: SpatialEditorProps['canvas']
  readonly createId: SpatialEditorProps['createId']
  readonly isImageFileRef: SpatialEditorProps['isImageFileRef']
  readonly missingFileRef: SpatialEditorProps['missingFileRef']
  readonly onOpenFileRef: SpatialEditorProps['onOpenFileRef']
  // declared LATER in the component body — the handlers call them at
  // event time, so the forward reference was fine there and becomes an
  // ordinary input here.
  readonly createNodeAt: (point: Point) => void
  readonly pasteClipboard: (at: Point) => void
  readonly openLinkNode: (node: SpatialNode) => void
  // derived in the component body
  readonly applyResult: (result: GestureResult) => void
  readonly capturePointer: (root: HTMLElement, pointerId: number) => void
  readonly extraIds: ReadonlySet<string>
  readonly hitTestProposal: (point: Point) => string | undefined
  readonly isOverlayEvent: (e: React.SyntheticEvent) => boolean
  readonly lastStrokeRef: RefObject<PreviousStroke | null>
  readonly menuPickInputs: PickInputs
  readonly openProposalId: string | null
  readonly pickInputs: PickInputs
  readonly pressedProposalRef: RefObject<{
    readonly id: string
    readonly startScreen: Point
  } | null>
  readonly rootRef: RefObject<HTMLDivElement | null>
  readonly runNavigation: (
    root: HTMLElement,
    event: NavigationEvent,
    at: number,
  ) => NavigationResult
  readonly selectedId: string | null
  readonly setOpenProposalId: Dispatch<SetStateAction<string | null>>
  readonly toggleSelectionMember: (primaryId: string | null, hitId: string) => void
}

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
    commentById,
    commentDrag,
    commentPlacementObstacles,
    hitTestComment,
    openCommentId,
    pressedCommentRef,
    setCommentDrag,
    setOpenCommentId,
    toggleCommentCard,
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
    setContextMenu,
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
    hitTestProposal,
    isOverlayEvent,
    lastStrokeRef,
    menuPickInputs,
    openProposalId,
    pickInputs,
    pressedProposalRef,
    rootRef,
    runNavigation,
    selectedId,
    setOpenProposalId,
    toggleSelectionMember,
  } = inputs

  /**
   * A press an overlay took. The one rejection that used to leave no trace
   * at all — a dead zone made of chrome reads as nothing having happened —
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
    if (openCommentId !== null && hitTestComment(point) !== openCommentId) {
      setOpenCommentId(null)
    }
    if (openProposalId !== null && hitTestProposal(point) !== openProposalId) {
      setOpenProposalId(null)
    }
  }

  /**
   * A press on a comment's chrome is remembered BEFORE navigation gets the
   * press, because in hand mode navigation takes every plain press as a pan
   * and never hands it back — and a comment is chrome, not content: a reader
   * panning around a canvas has as much reason to open a conversation as one
   * selecting on it.
   *
   * The release decides (see `handlePointerUp`): a press that never travelled
   * opens the card under either tool; one that travelled was the pan (hand)
   * or the pin drag (select) it became on the way.
   */
  const rememberPressedComment = (
    e: React.PointerEvent<HTMLDivElement>,
    point: Point,
    screenPoint: Point,
  ): void => {
    const hitCommentId = e.button === 0 ? hitTestComment(point) : undefined
    if (hitCommentId === undefined) return
    const comment = commentById(hitCommentId)
    if (comment === undefined) return
    pressedCommentRef.current = { comment, startScreen: screenPoint, startPoint: point }
  }

  /**
   * A proposal's BUBBLE is chrome above the content, so a press on it opens
   * the card at the release rather than selecting whatever is under it.
   *
   * Its change OUTLINES are deliberately not tested: they are drawn on the
   * document at the place a change would land, and making them pressable
   * would put a dead zone over the node they describe.
   */
  const claimProposalBubble = (point: Point, screenPoint: Point): boolean => {
    const hitProposalId = hitTestProposal(point)
    if (hitProposalId === undefined) return false
    pressedProposalRef.current = { id: hitProposalId, startScreen: screenPoint }
    return true
  }

  /**
   * The draw tool makes the board a sheet of paper: a press starts a stroke,
   * with no hit-test at all.
   *
   * It sits after the annotation layer's own chrome, which floats above the
   * document and keeps its press. Capture is taken HERE rather than on the
   * first move (the rule `captureOnFirstMove` states), or a stroke that
   * leaves the root stops at its edge and the release is never seen.
   */
  const beginDrawStroke = (
    e: React.PointerEvent<HTMLDivElement>,
    root: HTMLElement,
    point: Point,
  ): boolean => {
    if (tool !== 'draw') return false
    capturePointer(root, e.pointerId)
    // Which MARK this stroke belongs to, decided here because this is where
    // the clock is: a stroke that goes down soon after the last one came up,
    // near where it was drawn, is the next stroke of the same character
    // rather than a new one (`stroke-group.ts`). The reducer's own default
    // mints the id, so a test injecting `createId` gets deterministic groups.
    const previous = lastStrokeRef.current ?? undefined
    const group = continuesStroke(previous, e.timeStamp, point, viewport.zoom)
      ? previous?.group
      : (createId ?? defaultCreateId)()
    applyResult(
      reduceGesture(gestureState, canvas, {
        type: 'pointerdown-draw',
        point,
        zoom: viewport.zoom,
        ...(group === undefined ? {} : { group }),
      }),
    )
    return true
  }

  /**
   * Shift-click builds a multi-selection instead of starting a gesture.
   *
   * What it MEANS per kind is `element-pick.ts`'s: the two arms used to be
   * written where each was first needed, which is how ink came to fall
   * through the node arm entirely. A kind it answers `none` for falls
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
   * A press that landed on no node: the marquee starts, and a stroke under
   * the pointer is armed to travel with it.
   *
   * A press on a MEMBER keeps the whole set; anything else replaces it with
   * the pressed stroke's MARK — a handwritten character is several strokes
   * and a person pressing one means it. Same rule the node branch and the
   * context menu follow. `pointerdown-ink` drops every id that is not a
   * stroke, so a press on a RELATION arms nothing and falls through to the
   * band: an edge's path is routed from the boxes it joins and has no
   * geometry of its own to drag.
   */
  const pressOnEmptyBoard = (point: Point, hitPathId: string | undefined): void => {
    setMarquee({ start: point, current: point })
    applySelection({ type: 'collapse-extras' })
    if (hitPathId === undefined) {
      setSelectedEdgeId(null)
      applyResult(reduceGesture(gestureState, canvas, { type: 'pointerdown-empty' }))
      return
    }
    const travelling = selectedInkIds.includes(hitPathId)
      ? selectedInkIds
      : withGroupMates([hitPathId], canvas.lines)
    setSelectedInkIds(travelling)
    const armed = reduceGesture(gestureState, canvas, {
      type: 'pointerdown-ink',
      ids: travelling,
      point,
    })
    if (armed.state.kind === 'moving-ink') {
      setMarquee(null)
      applyResult(armed)
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
   * A press is offered to each claimant in PRIORITY ORDER, and the first that
   * takes it stops the chain — the same shape `handlePointerMove` below
   * already had, applied to the path that never got it.
   *
   * The order is the whole content of this function: chrome above the
   * document claims before the document does, navigation answers before
   * either, and what each position is FOR is on the claimant rather than in a
   * comment beside a `return`.
   */
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
    rememberPressedComment(e, point, screenPoint)
    // Navigation answers for its own state. Everything it owns — which finger
    // is down, whether two of them are driving the viewport, whether this
    // press continues a gather — lives in one value in `navigation.ts` rather
    // than in the refs this used to read.
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
    if (pressedCommentRef.current !== null) return true
    return claimProposalBubble(point, screenPoint)
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
    // model holds (`element-pick.ts`). It used to be three hit-tests two
    // hundred lines apart, so the priority between them was a property of
    // where each had been written — and a kind nobody had written was simply
    // never tested for.
    const pick = pickContentAt(pressProbes(pickInputs), point)
    const { hitId, hitPathId, pressKey } = describePress(pick)

    if (chromeClaimsPress(e, root, point, screenPoint, hitId)) return
    if (beginDrawStroke(e, root, point)) return
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

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (root === null) return
    // Inside a node's text editor the object is the TEXT: the menu is the
    // editing catalog (the note editor's own, Comment included), the way
    // the note editor answers a right-click on a selection.
    const editor = getActiveMarkdownEditor()
    if (
      editor !== null &&
      e.target instanceof Element &&
      e.target.closest('[data-testid="text-node-editor"]') !== null
    ) {
      e.preventDefault()
      const at = clientPointToRootLocal(e, root)
      setContextMenu({
        x: at.x,
        y: at.y,
        nodeId: undefined,
        edgeId: undefined,
        point: screenToCanvas(at, viewport),
        editor,
      })
      return
    }
    if (isOverlayEvent(e)) return
    // Replace the browser menu with the object's own action menu.
    e.preventDefault()
    openContextMenuAt(clientPointToRootLocal(e, root))
  }

  /**
   * A comment under the pointer gets ITS menu — and leaves the node or edge
   * selection alone, since the menu is about the comment.
   */
  const openCommentMenuAt = (screenPoint: Point, point: Point): boolean => {
    const hitCommentId = hitTestComment(point)
    if (hitCommentId === undefined) return false
    setContextMenu({
      x: screenPoint.x,
      y: screenPoint.y,
      nodeId: undefined,
      edgeId: undefined,
      commentId: hitCommentId,
      point,
    })
    return true
  }

  /**
   * In hand mode the menu carries the ANNOTATION verbs and nothing else.
   *
   * Hand mode keeps CONTENT out of reach — a press pans, nothing selects,
   * nothing edits — but a conversation about what is on screen is not
   * content, and a reader panning has as much reason to open one as a reader
   * selecting. The press selects nothing along the way: an editing affordance
   * surfacing mid-pan was the harm (user report 2026-08-08), and a comment
   * verb is not one.
   */
  const openHandModeMenuAt = (
    screenPoint: Point,
    point: Point,
    hitId: string | undefined,
    hitPathId: string | undefined,
  ): boolean => {
    if (tool !== 'hand') return false
    setContextMenu({
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
   * Node and edge selection stay mutually exclusive here, as on the press
   * path: Delete acts on a selected edge FIRST, so leaving the other object
   * type selected makes Delete remove the wrong thing.
   *
   * A press on a MEMBER keeps the whole set and leads with the pressed one; a
   * press on anything else replaces it. Both collections follow that rule now
   * — ink had the other one, where `setSelectedEdgeId` collapsed the
   * selection to a single id, so right-clicking one stroke of a gathered
   * scribble threw the rest away and every verb that acts on the SET could
   * never be offered from the menu that is supposed to offer them.
   */
  const settleMenuSelection = (hitId: string | undefined, hitPathId: string | undefined): void => {
    // Node and edge selection stay mutually exclusive here too (see the
    // pointerdown path): Delete acts on a selected edge FIRST, so leaving
    // the other object type selected makes Delete remove the wrong thing.
    if (hitId !== undefined && !isLocked(hitId)) {
      // Right-clicking a member of an existing multi-selection must not
      // shrink it: the target is promoted to primary and the old primary
      // stays in the extras, or "Group selection" silently loses a node.
      // An OUTSIDER collapses the selection to itself, same as a plain
      // left press — old extras must not ride along into its menu actions.
      applySelection(
        hitId === selectedId || extraIds.has(hitId)
          ? { type: 'promote', id: hitId }
          : { type: 'set-members', ids: [hitId] },
      )
      setSelectedEdgeId(null)
    }
    if (hitPathId !== undefined) {
      // A press on a MEMBER keeps the whole set and leads with the pressed
      // one; a press on anything else replaces it. That is the rule the
      // node branch above already follows (`promote` against
      // `set-members`), and ink had the other one: `setSelectedEdgeId`
      // collapses the selection to a single id, so right-clicking one
      // stroke of a gathered scribble threw the rest away — and every verb
      // that acts on the SET (Group, and whatever joins it) could never be
      // offered from the menu that is supposed to offer them.
      setSelectedInkIds((current) =>
        current.includes(hitPathId)
          ? [hitPathId, ...current.filter((id) => id !== hitPathId)]
          : [hitPathId],
      )
      applySelection({ type: 'clear' })
    }
  }

  const openContextMenuAt = (screenPoint: Point) => {
    const point = screenToCanvas(screenPoint, viewport)
    if (openCommentMenuAt(screenPoint, point)) return
    const menuPick = pickContentAt(pressProbes(menuPickInputs), point)
    const hitId = menuPick?.kind === 'nodes' ? menuPick.id : undefined
    // An edge and a line alike: the menu builder resolves which it is out
    // of the canvas, the same way the selection does.
    const hitPathId = menuPick !== undefined && menuPick.kind !== 'nodes' ? menuPick.id : undefined
    if (openHandModeMenuAt(screenPoint, point, hitId, hitPathId)) return
    settleMenuSelection(hitId, hitPathId)
    setContextMenu({
      x: screenPoint.x,
      y: screenPoint.y,
      nodeId: hitId,
      edgeId: hitPathId,
      point,
    })
  }
  openContextMenuAtRef.current = openContextMenuAt

  /**
   * The steps `handlePointerMove` runs, in the order it runs them — which
   * is the semantics rather than a detail: a pointer move belongs to at
   * most one gesture, and an earlier step winning is how that is decided.
   *
   * They stay in THIS scope rather than becoming module functions because
   * the handler closes over 32 values (counted, not guessed); moving them
   * out turns those into 32 parameters, which is the same knot with a
   * longer signature. What the split buys is that each step has a name and
   * keeps its own reason beside it, and the handler below reads as the
   * order.
   *
   * A step that ANSWERS the move returns true; one that only has a side
   * effect returns nothing.
   */

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

  /**
   * A comment press that travels past the slop is spent as a press.
   *
   * Under the select tool it becomes the pin drag of a point-anchored
   * comment (a node-anchored one's anchor is its node's corner, and moving
   * the node is how it moves); under the hand tool it was a pan, which
   * navigation is already running and which the release must not turn into
   * an opened card. Decided BEFORE navigation because a pan's moves never
   * fall through. Capture FIRST for the drag: it takes the committed copy
   * out of the surface, and a touch pointer's implicit capture sits on that
   * copy.
   *
   * The press is spent either way — `pressedCommentRef` is cleared before
   * the tool is consulted — so a hand-tool press that travelled does not
   * come back as a card on release.
   */
  const startCommentPinDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    root: HTMLElement,
    screenPoint: Point,
  ): boolean => {
    const pressedComment = pressedCommentRef.current
    if (
      pressedComment === null ||
      commentDrag !== null ||
      Math.hypot(
        screenPoint.x - pressedComment.startScreen.x,
        screenPoint.y - pressedComment.startScreen.y,
      ) < COMMENT_PRESS_SLOP_PX
    ) {
      return false
    }
    pressedCommentRef.current = null
    if (
      tool === 'hand' ||
      spaceDownRef.current ||
      pressedComment.comment.targetNodeId !== undefined
    ) {
      return false
    }
    capturePointer(root, e.pointerId)
    setCommentDrag({
      comment: pressedComment.comment,
      startPoint: pressedComment.startPoint,
      live: screenToCanvas(screenPoint, viewport),
      obstacles: commentPlacementObstacles(pressedComment.comment.id),
      dropped: null,
    })
    return true
  }

  /**
   * A pin already in flight follows the pointer until it is dropped. A
   * dropped one still ANSWERS the move — it is the same drag, finished —
   * so nothing below runs for it.
   */
  const advanceCommentDrag = (screenPoint: Point): boolean => {
    if (commentDrag === null) return false
    if (commentDrag.dropped === null) {
      setCommentDrag({ ...commentDrag, live: screenToCanvas(screenPoint, viewport) })
    }
    return true
  }

  const advanceMarquee = (screenPoint: Point): boolean => {
    if (marquee === null) return false
    setMarquee({ start: marquee.start, current: screenToCanvas(screenPoint, viewport) })
    return true
  }

  /**
   * Unsnapped: snapping lines an object up with its neighbours, and a
   * hand-drawn stroke has no such intent — a guide would redraw it.
   *
   * Reduced from the PREVIOUS state through a functional update rather
   * than through `applyResult`, and that is the difference between a
   * stroke and a straight line: `pointermove` is a continuous event, so
   * the browser delivers several before React re-renders, and a handler
   * reducing from its own render's `gestureState` has each move overwrite
   * the last. Measured on a 61-sample wave drawn in one turn: ONE bend
   * survived. No other gesture needs this — they all recompute from their
   * start snapshot and the current point, and accumulate nothing.
   */
  const advanceDrawing = (screenPoint: Point): boolean => {
    if (gestureStateRef.current.kind !== 'drawing') return false
    applyResult(
      reduceGesture(gestureStateRef.current, canvasRef.current, {
        type: 'pointermove',
        point: screenToCanvas(screenPoint, viewport),
      }),
    )
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

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (root === null) return
    cancelLongPressPastSlop(e, root)
    const screenPoint = clientPointToRootLocal(e, root)
    captureOnFirstMove(e, root)
    if (startCommentPinDrag(e, root, screenPoint)) return
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
    if (advanceCommentDrag(screenPoint)) return
    if (advanceMarquee(screenPoint)) return
    if (gestureState.kind === 'idle' && gestureStateRef.current.kind !== 'drawing') return
    if (advanceDrawing(screenPoint)) return
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
   * A press on a comment's chrome, answered at the release.
   *
   * Consumed here whatever happens next, so a press on a comment can never
   * open its card two gestures later. A press that never travelled opens the
   * card under EITHER tool: in hand mode the press armed a pan that this
   * release is ending, and the machine answers for that pan — but the pan
   * moved nothing, and the comment's answer comes first. A travelled press
   * was spent on the first move.
   */
  const releasePressedComment = (): boolean => {
    const pressedComment = pressedCommentRef.current
    pressedCommentRef.current = null
    if (pressedComment === null || commentDrag !== null) return false
    toggleCommentCard(pressedComment.comment.id)
    return true
  }

  /**
   * A press on a proposal's bubble, answered at the release.
   *
   * Consumed here whatever happens next, like the comment press above. A
   * press that travelled was a pan and opens nothing; one that stayed put
   * toggles the card, so pressing the bubble again is how it shuts.
   */
  const releasePressedProposal = (e: React.PointerEvent<HTMLDivElement>, root: HTMLElement) => {
    const pressedProposal = pressedProposalRef.current
    pressedProposalRef.current = null
    if (pressedProposal === null) return false
    const stayed =
      travelled(clientPointToRootLocal(e, root), pressedProposal.startScreen) <
      COMMENT_PRESS_SLOP_PX
    if (!stayed) return false
    setOpenProposalId((current) => (current === pressedProposal.id ? null : pressedProposal.id))
    return true
  }

  /**
   * The end of a comment-pin drag.
   *
   * A press that never travelled is a PRESS (the card toggle owns it), not a
   * zero-distance move. The anchor is ROUNDED because the model requires an
   * integer and a reader silently drops a comment that fails the schema — a
   * fractional anchor from a zoomed viewport would survive this session and
   * vanish on the next undo, reload or remote import. The preview parks
   * exactly on the rounded anchor, so the committed copy takes over without a
   * sub-pixel step.
   */
  const commitCommentDrag = (e: React.PointerEvent<HTMLDivElement>, root: HTMLElement): boolean => {
    if (commentDrag === null) return false
    if (commentDrag.dropped !== null) return true
    const released = screenToCanvas(clientPointToRootLocal(e, root), viewport)
    const dx = released.x - commentDrag.startPoint.x
    const dy = released.y - commentDrag.startPoint.y
    if (dx === 0 && dy === 0) {
      setCommentDrag(null)
      toggleCommentCard(commentDrag.comment.id)
      return true
    }
    const dropped = {
      x: Math.round(commentDrag.comment.x + dx),
      y: Math.round(commentDrag.comment.y + dy),
    }
    setCommentDrag({
      ...commentDrag,
      live: {
        x: commentDrag.startPoint.x + (dropped.x - commentDrag.comment.x),
        y: commentDrag.startPoint.y + (dropped.y - commentDrag.comment.y),
      },
      dropped,
    })
    applyResult({
      state: { kind: 'idle' },
      commands: [{ kind: 'move-comment', id: commentDrag.comment.id, ...dropped } as const],
    })
    return true
  }

  /**
   * The end of an ink drag.
   *
   * The ink drag replaced the marquee this press used to start, and two
   * things the marquee branch did for a press ON ink had to come with it.
   * Both were found by the full browser run rather than by reading: each is
   * about what happens AFTER a release that wrote nothing, so the drag's own
   * tests passed over them.
   *
   * Unsnapped, for the reason the stroke's own release is: ink is sub-pixel
   * by nature, and a snapped release would quantise a whole scribble to a box
   * grid it was never drawn on. Focus is taken at the RELEASE because ink has
   * no focusable element of its own — a drawn path carries no tabIndex — so
   * without it Delete and Escape land on `<body>`, and the browser's own
   * mousedown focus handling would undo one taken at the press.
   */
  const releaseInkDrag = (
    e: React.PointerEvent<HTMLDivElement>,
    root: HTMLElement,
    armed: { key: string; point: Point } | null,
  ): boolean => {
    if (gestureState.kind !== 'moving-ink') return false
    const released = screenToCanvas(clientPointToRootLocal(e, root), viewport)
    applyResult(reduceGesture(gestureState, canvas, { type: 'pointerup', point: released }))
    // A double press on a stroke edits its label, exactly as on a relation —
    // the press key is `edge:<id>` for both.
    if (armed?.key.startsWith('edge:')) {
      setEdgeLabelEditId(armed.key.slice('edge:'.length))
    }
    root.focus()
    return true
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
    if (releasePressedComment()) return true
    if (releasePressedProposal(e, root)) return true
    if (!navigationFellThrough) return true
    return commitCommentDrag(e, root)
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
    if (releaseInkDrag(e, root, armed)) return
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
    // this handler used to do by hand across four refs.
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
    pressedCommentRef.current = null
    pressedProposalRef.current = null
    setCommentDrag(null)
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
