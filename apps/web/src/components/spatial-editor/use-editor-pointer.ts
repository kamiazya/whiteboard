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
import { isFrame, nodeFile, nodeSubpath, nodeText, nodeUrl } from '@kamiazya/whiteboard-model'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { defaultCreateId } from '../../lib/spatial/element-id.js'
import { hitTest } from '../../lib/spatial/geometry.js'
import {
  continuesStroke,
  type PreviousStroke,
  strokeBounds,
} from '../../lib/spatial/stroke-group.js'
import { clientPointToRootLocal, type Point, screenToCanvas } from '../../lib/spatial/viewport.js'
import { getActiveMarkdownEditor } from '../markdown-editor/active-markdown-editor.js'
import type { PickInputs } from './element-pick.js'
import {
  bandProbes,
  pickContentAt,
  pickContentWithin,
  pressProbes,
  shiftPress,
} from './element-pick.js'
import { snapGesturePoint } from './gesture-snap.js'
import { describeTarget, gestureTrace } from './gesture-trace.js'
import { carriedByGesture } from './gesture-view.js'
import type { GestureResult } from './gestures.js'
import { reduceGesture } from './gestures.js'
import { withGroupMates } from './ink-hit.js'
import type { PointerKind } from './navigation.js'
import {
  DOUBLE_PRESS_WINDOW_MS,
  type NavigationEvent,
  type NavigationResult,
} from './navigation.js'
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

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isOverlayEvent(e)) {
      // The one rejection that used to leave no trace at all: a press an
      // overlay took never reaches the machine, so a dead zone made of
      // chrome reads as nothing having happened. The recorder names what
      // took it.
      gestureTrace.recordOverlayRejected({
        at: Math.round(e.timeStamp),
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        target: describeTarget(e.target),
      })
      return
    }
    const root = rootRef.current
    if (root === null) return
    const screenPoint = clientPointToRootLocal(e, root)
    const point = screenToCanvas(screenPoint, viewport)
    // WHICH KIND the press lands on, decided in one place for every kind
    // the model holds (`element-pick.ts`). It used to be three hit-tests
    // two hundred lines apart, so the priority between them was a property
    // of where each had been written — and a kind nobody had written was
    // simply never tested for. Each branch below reads the one answer.
    const pick = pickContentAt(pressProbes(pickInputs), point)
    // Answering `undefined` for the node when ink won makes every branch
    // below treat the press as one on ink over empty board, which is what
    // it is.
    const hitInkId = pick?.kind === 'lines' ? pick.id : undefined
    const hitId = pick?.kind === 'nodes' ? pick.id : undefined
    // A press on the canvas surface shuts the open conversation, the way
    // a pointerdown outside a menu shuts the menu. It is the one dismissal
    // a phone has: there is no Escape, and the card covers the bubble
    // whose second press would otherwise toggle it. A press on the open
    // comment's own chrome (its pin, which the card leaves uncovered) is
    // left to the release, which toggles it shut as before.
    if (openCommentId !== null && hitTestComment(point) !== openCommentId) {
      setOpenCommentId(null)
    }
    // A press on a comment's chrome is remembered BEFORE navigation gets
    // the press, because in hand mode navigation takes every plain press
    // as a pan and never hands it back — and a comment is chrome, not
    // content: a reader panning around a canvas has as much reason to
    // open a conversation as one selecting on it. The release decides
    // (see handlePointerUp): a press that never travelled opens the card
    // under either tool; one that travelled was the pan (hand) or the
    // pin drag (select) it became on the way.
    // The proposal card is dismissed by a press off it, like the comment
    // card above and for the same reason: the card covers its own bubble,
    // so the second press that would toggle it shut lands on the card.
    if (openProposalId !== null && hitTestProposal(point) !== openProposalId) {
      setOpenProposalId(null)
    }
    const hitCommentId = e.button === 0 ? hitTestComment(point) : undefined
    if (hitCommentId !== undefined) {
      const comment = commentById(hitCommentId)
      if (comment !== undefined) {
        pressedCommentRef.current = { comment, startScreen: screenPoint, startPoint: point }
      }
    }
    // Navigation answers first, and answers for its own state. Everything
    // it owns — which finger is down, whether two of them are driving the
    // viewport, whether this press continues a gather — lives in one value
    // in `navigation.ts` rather than in the refs this used to read.
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
        context: {
          handMode: tool === 'hand',
          spaceDown: spaceDownRef.current,
          hitId,
          // The anchor a gather would extend. Mid-gather it is the standing
          // selection; otherwise only a node this press could join to, which
          // is why entering hand mode — which clears the selection — can
          // never gather.
          anchorPrimaryId:
            navigationRef.current.mode.kind === 'gathering'
              ? selectedId
              : gestureState.kind === 'moving'
                ? gestureState.nodeId
                : null,
          manipulating: gestureState.kind !== 'idle',
        },
      },
      e.timeStamp,
    )
    if (navigation.preventDefault === true) e.preventDefault()
    if (!navigation.fallThrough) return
    if (e.button !== 0) return
    // A comment's chrome floats above content, so it was tested before
    // the nodes under it (above). A press on it never falls through to
    // node or marquee handling: a press that stays put OPENS the
    // conversation at the release, and one that travels drags the pin of
    // a point-anchored comment. A node-anchored comment's anchor IS its
    // node's corner, so its pin does not drag — moving the node is how it
    // moves (and the comment rides along).
    //
    // There is deliberately no double-press-to-edit here any more. A
    // single press now opens the card, whose own top-right Edit is the
    // successor: the second press of a pair would land on that card, which
    // stops propagation, so the pairing could never complete.
    if (pressedCommentRef.current !== null) return
    // A proposal's BUBBLE is chrome above the content, so a press on it
    // opens the card at the release rather than selecting whatever is
    // under it. Its change OUTLINES are deliberately not tested: they are
    // drawn on the document at the place a change would land, and making
    // them pressable would put a dead zone over the node they describe.
    const hitProposalId = hitTestProposal(point)
    if (hitProposalId !== undefined) {
      pressedProposalRef.current = { id: hitProposalId, startScreen: screenPoint }
      return
    }
    // The draw tool makes the board a sheet of paper: a press starts a
    // stroke, with no hit-test at all. It sits after the annotation
    // layer's own chrome, which floats above the document and keeps its
    // press. Capture is taken HERE rather than on the first move (the
    // rule just below), or a stroke that leaves the root stops at its
    // edge and the release is never seen.
    if (tool === 'draw') {
      capturePointer(root, e.pointerId)
      // Which MARK this stroke belongs to, decided here because this is
      // where the clock is: a stroke that goes down soon after the last
      // one came up, near where it was drawn, is the next stroke of the
      // same character rather than a new one (`stroke-group.ts`).
      const previous = lastStrokeRef.current ?? undefined
      // The reducer's own default, so a group id is minted exactly the way
      // an element id is — and a test injecting `createId` gets
      // deterministic groups too.
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
      return
    }
    // Deliberately NO pointer capture here. Capturing on the press
    // retargets the subsequent clicks to the capturing root, so a control
    // the press bubbled from never receives its click. Capture is taken
    // on the first real pointermove instead (see handlePointerMove): a
    // press that turns into a drag still gets capture before it can
    // escape the element. Overlay handle/connect gestures are the
    // exception (beginOverlayGesture) — they want capture immediately.

    // Double-press detection is OURS, not the browser's `dblclick`: the
    // first press selects the node, which re-renders the DOM under the
    // pointer (selection overlay, gesture state), so the second click can
    // land on a different element instance and Chromium then never
    // synthesises a dblclick at all. Detecting two presses on the same
    // logical target within the OS-conventional window is stable against
    // re-renders because it compares node ids, not DOM identity.
    // Shift-click builds a multi-selection instead of starting a gesture.
    // What it MEANS per kind is `element-pick.ts`'s: the two arms used to
    // be written where each was first needed, which is how ink came to
    // fall through the node arm entirely. A kind it answers `none` for
    // falls through to the replacing paths below, carrying its reason.
    if (e.shiftKey) {
      const shift = shiftPress(pick, selectedInkIds, canvas.lines, withGroupMates)
      if (shift.kind === 'nodes') {
        toggleSelectionMember(selectedId, shift.id)
        return
      }
      if (shift.kind === 'paths') {
        setSelectedInkIds(shift.ids)
        return
      }
    }
    // The pick's answer for a path, which is an EDGE or a LINE: the press
    // paths below treat the two alike, because the selection state does —
    // `deleteInkCommand` is the one place that looks at which it is. It is
    // read here rather than probed again so the double-press pairing can
    // distinguish "double-click on an edge" (open its label editor) from
    // "double-click on empty space" (create a node); both have
    // hitId === undefined.
    const hitPathId = hitInkId ?? (pick?.kind === 'edges' ? pick.id : undefined)
    const pressKey = hitId ?? (hitPathId !== undefined ? `edge:${hitPathId}` : 'empty')
    const now = e.timeStamp
    const isDoublePress =
      lastPressRef.current !== null &&
      lastPressRef.current.key === pressKey &&
      now - lastPressRef.current.at <= DOUBLE_PRESS_WINDOW_MS
    lastPressRef.current = isDoublePress ? null : { key: pressKey, at: now, point: screenPoint }
    doublePressRef.current = isDoublePress ? { key: pressKey, point } : null

    if (hitId === undefined) {
      setMarquee({ start: point, current: point })
      applySelection({ type: 'collapse-extras' })
      if (hitPathId !== undefined) {
        // A press on a MEMBER keeps the whole set; anything else replaces
        // it with the pressed stroke's MARK — a handwritten character is
        // several strokes and a person pressing one means it. Same rule
        // the node branch and the context menu follow.
        const travelling = selectedInkIds.includes(hitPathId)
          ? selectedInkIds
          : withGroupMates([hitPathId], canvas.lines)
        setSelectedInkIds(travelling)
        // Ink travels under the pointer now. `pointerdown-ink` drops every
        // id that is not a stroke, so a press on a RELATION arms nothing
        // and falls through to the band exactly as it did — an edge's path
        // is routed from the boxes it joins and has no geometry of its own
        // to drag.
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
        return
      }
      setSelectedEdgeId(null)
      applyResult(reduceGesture(gestureState, canvas, { type: 'pointerdown-empty' }))
      return
    }
    // A plain press on a NON-member collapses the multi-selection; a press
    // on a member keeps the whole set and leads with the pressed node —
    // the reducer owns both transitions.
    applySelection({ type: 'press', id: hitId })
    setSelectedEdgeId(null)
    // Connect tool: the FIRST node press arms the connect (the same
    // reducer arm the keyboard/handle flows use). While 'connecting', a
    // node press is swallowed — the connect completes on the POINTERUP
    // over the target (the reducer's completion arm), so dispatching a
    // plain pointerdown here would tear the in-flight connect down first.
    if (tool === 'connect' && hitId !== undefined) {
      if (gestureState.kind !== 'connecting') {
        applyResult(
          reduceGesture(gestureState, canvas, { type: 'pointerdown-connect', nodeId: hitId }),
        )
      }
      return
    }
    applyResult(reduceGesture(gestureState, canvas, { type: 'pointerdown', nodeId: hitId, point }))
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

  const openContextMenuAt = (screenPoint: Point) => {
    const point = screenToCanvas(screenPoint, viewport)
    // A comment under the pointer gets ITS menu — and leaves the node or
    // edge selection alone, since the menu is about the comment.
    const hitCommentId = hitTestComment(point)
    if (hitCommentId !== undefined) {
      setContextMenu({
        x: screenPoint.x,
        y: screenPoint.y,
        nodeId: undefined,
        edgeId: undefined,
        commentId: hitCommentId,
        point,
      })
      return
    }
    const menuPick = pickContentAt(pressProbes(menuPickInputs), point)
    const hitId = menuPick?.kind === 'nodes' ? menuPick.id : undefined
    // An edge and a line alike: the menu builder resolves which it is out
    // of the canvas, the same way the selection does.
    const hitPathId = menuPick !== undefined && menuPick.kind !== 'nodes' ? menuPick.id : undefined
    // Hand mode keeps CONTENT out of reach — a press pans, nothing
    // selects, nothing edits — but a conversation about what is on screen
    // is not content, and a reader panning has as much reason to open one
    // as a reader selecting. So the menu opens with the annotation verb
    // for what is under the press and nothing else, and the press selects
    // nothing along the way: an editing affordance surfacing mid-pan was
    // the harm (user report 2026-08-08), and a comment verb is not one.
    if (tool === 'hand') {
      setContextMenu({
        x: screenPoint.x,
        y: screenPoint.y,
        nodeId: hitId,
        edgeId: hitPathId,
        point,
        verbs: 'annotation',
      })
      return
    }
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
    // Consumed here whatever happens next, so a press on a comment can
    // never open its card two gestures later. A press that never
    // travelled opens the card under EITHER tool: in hand mode the press
    // armed a pan that this release is ending, and the machine answers
    // for that pan — but the pan moved nothing, and the comment's answer
    // comes first. (A travelled press was spent on the first move.)
    const pressedComment = pressedCommentRef.current
    pressedCommentRef.current = null
    if (pressedComment !== null && commentDrag === null) {
      toggleCommentCard(pressedComment.comment.id)
      return
    }
    // Consumed here whatever happens next, like the comment press above. A
    // press that travelled was a pan and opens nothing; one that stayed put
    // toggles the card, so pressing the bubble again is how it shuts.
    const pressedProposal = pressedProposalRef.current
    pressedProposalRef.current = null
    if (
      pressedProposal !== null &&
      travelled(clientPointToRootLocal(e, root), pressedProposal.startScreen) <
        COMMENT_PRESS_SLOP_PX
    ) {
      setOpenProposalId((current) => (current === pressedProposal.id ? null : pressedProposal.id))
      return
    }
    // A release the machine answered was navigation — a finger leaving a
    // gather or a pinch, or the end of a pan. None of them run the click
    // and marquee semantics below: the sequence was never a gesture on the
    // canvas, and treating its release as one would re-collapse the very
    // selection the gather just built.
    if (!navigation.fallThrough) return
    if (commentDrag !== null) {
      if (commentDrag.dropped !== null) return
      const released = screenToCanvas(clientPointToRootLocal(e, root), viewport)
      const dx = released.x - commentDrag.startPoint.x
      const dy = released.y - commentDrag.startPoint.y
      // A press that never travelled is a press (the double-press pairing
      // above owns it), not a zero-distance move. The anchor is ROUNDED:
      // the model requires an integer, and a reader silently drops a
      // comment that fails the schema — a fractional anchor from a zoomed
      // viewport would survive this session and vanish on the next undo,
      // reload or remote import.
      if (dx === 0 && dy === 0) {
        setCommentDrag(null)
        toggleCommentCard(commentDrag.comment.id)
        return
      }
      const dropped = {
        x: Math.round(commentDrag.comment.x + dx),
        y: Math.round(commentDrag.comment.y + dy),
      }
      // The preview parks exactly on the rounded anchor, so the committed
      // copy takes over without a sub-pixel step.
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
      return
    }
    const armed = doublePressRef.current
    doublePressRef.current = null
    if (gestureState.kind === 'moving-ink' && root !== null) {
      // The ink drag replaced the marquee this press used to start, and
      // two things the marquee branch did for a press ON ink had to come
      // with it. Both were found by the full browser run rather than by
      // reading: each is about what happens AFTER a release that wrote
      // nothing, so the drag's own tests passed over them.
      //
      // Unsnapped, and the same reason the stroke's own release is: ink is
      // sub-pixel by nature, and a snapped release would quantise a whole
      // scribble to a box grid it was never drawn on.
      const released = screenToCanvas(clientPointToRootLocal(e, root), viewport)
      applyResult(reduceGesture(gestureState, canvas, { type: 'pointerup', point: released }))
      // A double press on a stroke edits its label, exactly as on a
      // relation — the press key is `edge:<id>` for both.
      if (armed?.key.startsWith('edge:')) {
        setEdgeLabelEditId(armed.key.slice('edge:'.length))
      }
      // Ink has no focusable element of its own (node shapes carry
      // tabIndex; a drawn path does not), so without this the real
      // keyboard's Delete and Escape land on <body> and never reach this
      // root's onKeyDown. Taken at the RELEASE because the browser's own
      // mousedown focus handling would undo one taken at the press.
      root.focus()
      return
    }
    if (marquee !== null) {
      setMarquee(null)
      const zeroMove =
        marquee.start.x === marquee.current.x && marquee.start.y === marquee.current.y
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
    if (root === null) return
    const screenPoint = clientPointToRootLocal(e, root)
    // Unsnapped like its samples: the ink ends where the hand stopped.
    if (gestureStateRef.current.kind === 'drawing') {
      const released = screenToCanvas(screenPoint, viewport)
      const drawn = gestureStateRef.current
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
      result.commands.length === 0
    ) {
      const node = canvasRef.current.nodes.find((n) => n.id === gestureState.nodeId)
      // Each arm asks what the node HOLDS rather than narrowing on the
      // stored discriminant. Resolved once, in a block rather than an early
      // return: a press on a node that is gone still falls through to the
      // `applyResult(result)` at the end of this handler, as it always did.
      if (node !== undefined) {
        const text = nodeText(node)
        if (text !== undefined) {
          applyResult(
            reduceGesture(result.state, canvas, {
              type: 'start-text-edit',
              nodeId: node.id,
              text,
            }),
          )
          return
        }
        // A link node's double press follows the reference, mirroring the
        // text node's double-press-edits rule: the object's primary action.
        if (nodeUrl(node) !== undefined) {
          applyResult(result)
          openLinkNode(node)
          return
        }
        // A group's double press edits its label — the frame's one own datum.
        if (isFrame(node)) {
          applyResult(result)
          setGroupLabelEditId(node.id)
          return
        }
        // A file node's double press follows the reference (navigate), the
        // same primary-action rule as link nodes. Image references are not
        // followable — navigating to an asset id is a dead end.
        const file = nodeFile(node)
        if (
          file !== undefined &&
          onOpenFileRef !== undefined &&
          isImageFileRef?.(file) !== true &&
          missingFileRef?.(file) !== true
        ) {
          applyResult(result)
          onOpenFileRef(file, nodeSubpath(node))
          return
        }
      }
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
      const followerMoves = [
        ...carriedByGesture(canvasRef.current, gestureState, extraIds, isLocked),
      ]
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
