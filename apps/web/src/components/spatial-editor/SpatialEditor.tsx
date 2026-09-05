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

import type {
  BoundingBox,
  MeasureText,
  ResolvedReference,
} from '@kamiazya/whiteboard-canvas-render'
import {
  BODY_FONT_SIZE_PX,
  BODY_LINE_HEIGHT_PX,
  COMMENT_BUBBLE_PADDING_PX,
  COMMENT_BUBBLE_RADIUS_PX,
  edgeLabelAnchor,
  outlineContentBox,
  placeCommentBubble,
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  SPATIAL_THEME_FONT_FAMILY,
  SPATIAL_THEME_GEOMETRY,
} from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import type { CommentThread, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { forwardRef, type ReactNode, useImperativeHandle, useMemo, useRef } from 'react'
import { writeLastTool } from '@/lib/initial-tool'
import { parseClipboardText } from '../../lib/clipboard-fragment.js'
import type { EditorTool } from '../../lib/editor-tool.js'
import { hapticTick } from '../../lib/haptics.js'
import type { FileRefOption } from '../../lib/link-entries.js'
import { hasCoarsePointer } from '../../lib/platform.js'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { applyCommand } from '../../lib/spatial/commands.js'
import { createEditorAppearance, editorTextFill } from '../../lib/spatial/editor-appearance.js'
import type { SpatialEditorHandle } from '../../lib/spatial/editor-handle.js'
import {
  distanceToPolyline,
  findFreeSpot,
  hitTest,
  indexNodeBoxes,
} from '../../lib/spatial/geometry.js'
import { requiredTextNodeHeight } from '../../lib/spatial/scene-render.js'
import { keyedWithoutPrefix } from '../../lib/spatial/scene-render-core.js'
import {
  canvasToScreen,
  fitViewportToBoxes,
  type Point,
  panBy,
  screenToCanvas,
  viewportTransformCss,
  zoomAt,
} from '../../lib/spatial/viewport.js'
import type { ResolvedTheme } from '../../lib/theme.js'
import type { BoxMove } from './align.js'
import { CanvasContextMenu } from './CanvasContextMenu.js'
import { CommentDragLayer } from './CommentDragLayer.js'
import { CommentThreadCard } from './CommentThreadCard.js'
import { ConnectOverlay } from './ConnectOverlay.js'
import { CREATION_LABELS } from './creation-labels.js'
import { DocumentPickerDialog } from './DocumentPickerDialog.js'
import { DragPreviewLayer } from './DragPreviewLayer.js'
import { isInFlightGesture } from './drag-preview.js'
import { EdgeSelectionHighlight } from './EdgeSelectionHighlight.js'
import { FacetFormPanel } from './facet-widgets/FacetFormPanel.js'
import { isFollowableUrl } from './followable-url.js'
import { GhostOverlay } from './GhostOverlay.js'
import { snapGesturePoint } from './gesture-snap.js'
import { describeTarget, gestureTrace } from './gesture-trace.js'
import { carriedByGesture } from './gesture-view.js'
import { defaultCreateId, NEW_NODE_HEIGHT, NEW_NODE_WIDTH, reduceGesture } from './gestures.js'
import { LinkEmbedLayer } from './LinkEmbedLayer.js'
import { LinkUrlDialog } from './LinkUrlDialog.js'
import { MarkdownNodeEditor } from './MarkdownNodeEditor.js'
import { MarqueeOverlay } from './MarqueeOverlay.js'
import { MemberOutlinesOverlay } from './MemberOutlinesOverlay.js'
import { MinimapOverlay } from './MinimapOverlay.js'
import {
  createIdleNavigation,
  DOUBLE_PRESS_WINDOW_MS,
  type NavigationEvent,
  type NavigationResult,
  type PointerKind,
  reduceNavigation,
} from './navigation.js'
import { PendingCutChip } from './PendingCutChip.js'
import { SelectionOverlay } from './SelectionOverlay.js'
import { SnapGuidesOverlay } from './SnapGuidesOverlay.js'
import { reduceSelection } from './selection.js'
import { isTextEntryEvent } from './shortcuts.js'
import { TextNodeEditor } from './TextNodeEditor.js'
import { type DraggableCreation, draggedCreation, ToolPalette } from './ToolPalette.js'
import { useCanvasReplacement } from './use-canvas-replacement.js'
import { useClipboardActions } from './use-clipboard-actions.js'
import { useCommentState } from './use-comment-state.js'
import { useDragLayers } from './use-drag-layers.js'
import { useEditSessionState } from './use-edit-session-state.js'
import { useEditorKeyboard } from './use-editor-keyboard.js'
import { MINIMAP_MIN_ROOT_WIDTH_PX, useEditorMeasurements } from './use-editor-measurements.js'
import { EXPAND_MIN_H, EXPAND_MIN_W, useFileSeamScene } from './use-file-seam-scene.js'
import { useInteractionState } from './use-interaction-state.js'
import { useKeyboardAvoidance } from './use-keyboard-avoidance.js'
import { useLockPolicy } from './use-lock-policy.js'
import { useNativeCanvasListeners } from './use-native-canvas-listeners.js'
import { useNodeBoxes } from './use-node-boxes.js'
import { useNodeCreation } from './use-node-creation.js'
import { useSceneProjection } from './use-scene-projection.js'
import { useToolState } from './use-tool-state.js'
import { useViewportControls } from './use-viewport-controls.js'
import { useWorkerScene } from './use-worker-scene.js'

/**
 * Machine-checkable out-of-scope list this slice deliberately does not
 * implement — referenced above and asserted by `doc-contract.test.ts`.
 */
export const SPATIAL_EDITOR_UNSUPPORTED = ['persistence', 'sync'] as const

/** Overview size. Big enough to aim at, small enough not to cover content. */
const MINIMAP_WIDTH_PX = 160
const MINIMAP_HEIGHT_PX = 110

/**
 * Below this container width the overview and the dock fight for the bottom
 * edge, so the overview yields.
 *
 * Both are bottom-anchored in the same container. The dock is centred and, on
 * a coarse pointer, runs about 380px; the overview claims 160px plus a 16px
 * inset on the right. They start touching once
 * `(W + 380) / 2 > W - 176`, i.e. below ~732px. 768 rounds that up so the two
 * never sit shoulder to shoulder with no gap.
 *
 * Keyed off the CONTAINER, not the viewport: a narrow editor column on a wide
 * screen collides in exactly the same way, and a media query cannot see it.
 */

/** The routing styles offered in the UI. */

export interface SpatialEditorProps {
  readonly canvas: SpatialCanvas
  readonly onChange: (next: SpatialCanvas, command: EditorCommand) => void
  /**
   * Bumps only on an externally-originated canvas replacement (undo, redo,
   * remote import, hydrate) — never on this component's own `onChange`.
   * Omitted (the default) means every `canvas` prop change is treated as
   * local, matching this component's pre-existing continue-if-valid
   * behavior. A controlling hook that distinguishes origins (see
   * `useDocumentSync`'s `externalVersion`) should always pass it, since an
   * external replacement must cancel an in-flight gesture unconditionally —
   * see gestures.ts's `canvas-replaced` origin contract.
   */
  readonly externalVersion?: number
  /** Injection seam for tests; defaults to the real Canvas 2D measurer. */
  readonly measure?: MeasureText
  /** Injection seam for deterministic node/edge-id tests; defaults to crypto.randomUUID. */
  readonly createId?: () => string
  readonly className?: string
  readonly testId?: string
  /**
   * The app's resolved UI theme, threaded straight from `useThemeMode` by
   * the caller. Defaults to `'light'` so existing mounts render the
   * pre-existing chrome unchanged; every real page mount must pass its own
   * `resolvedTheme` or its nodes/edges go invisible in dark mode.
   */
  readonly theme?: ResolvedTheme
  /**
   * The tool active on mount. Pages resolve it from the canvas's own shape
   * and the tab's last choice (`resolveInitialTool`): an empty canvas opens
   * ready to place, one with content opens in navigation mode so a plain
   * drag pans instead of moving someone's work. Defaults to 'hand' for
   * callers that express no preference; tests exercising editing flows pass
   * 'select' explicitly.
   */
  readonly defaultTool?: EditorTool
  /**
   * The tool this canvas should open in, resolved by the page only once its
   * document has loaded (the node count that decides it is not known at
   * mount). Applied exactly once, and never over a choice the user already
   * made with the palette — an opening preference must not reach in and
   * change the mode someone is working in.
   */
  readonly initialTool?: EditorTool
  /**
   * Node ids the user has locked. Lock is HOST state — it lives in the
   * Loro doc's sidecar map, not in the canvas value — so it arrives as a
   * prop and toggles are reported back through `onToggleNodeLock`.
   * A locked node cannot be selected, moved, resized, or deleted here;
   * unlock is the one action its menu still offers.
   */
  readonly lockedNodeIds?: ReadonlySet<string>
  /** Absent → the whole lock affordance hides and nothing is blocked. */
  readonly onToggleNodeLock?: (nodeId: string, locked: boolean) => void
  /**
   * Edge ids the user has locked — an independent set, NOT derived from
   * `lockedNodeIds`. An edge is its own object: locking a hub node must not
   * silently freeze every line touching it, and an edge between two free
   * nodes must still be lockable.
   */
  readonly lockedEdgeIds?: ReadonlySet<string>
  /** Absent → the edge-lock affordance hides and no edge is blocked. */
  readonly onToggleEdgeLock?: (edgeId: string, locked: boolean) => void
  /**
   * Node ids an agent just changed, outlined so a human can see WHERE the
   * board moved under them. Purely decorative — it blocks nothing and
   * selects nothing, and the caller clears it on its own schedule.
   */
  readonly agentTouchedNodeIds?: ReadonlySet<string>
  /**
   * Canvas references the picker offers for file nodes. The reference is an
   * OPAQUE string owned by the composition root (canvas id minted in the browser,
   * daemon alias path). Absent → the Document affordance hides.
   */
  readonly fileRefOptions?: readonly FileRefOption[]
  /** Follows a file node's reference (navigation). Absent → follow hides. */
  readonly onOpenFileRef?: (file: string, subpath?: string) => void
  /**
   * Opens a text node's body on a surface the HOST owns — the composition
   * root already holds the seams a full markdown editor needs (alias
   * resolution, link targets, embeds), so the canvas hands over the node and
   * its text and stays out of it. Absent means no such surface exists, and
   * the catalog does not offer the verb.
   */
  readonly onOpenInEditor?: (nodeId: string, text: string) => void
  /**
   * The document's conversations, for the card a press opens on a comment.
   *
   * The canvas's own `x-whiteboard.comments` is a lossy projection — one
   * `text` per comment, with nowhere for a reply to sit — so reading a
   * conversation needs the threads plane itself. Absent, a press still
   * selects nothing and the comment keeps its drawn bubble: a host with no
   * annotation channel has no conversation to open.
   */
  readonly threads?: readonly CommentThread[]
  /**
   * Marks a file reference whose target no longer exists (deleted canvas,
   * ref imported into a store that never had it). The card renders a quiet
   * "Missing reference" label and the follow affordances (context menu,
   * double-click) hide — following would dead-end, or worse lazily create
   * an empty canvas under the dangling ref. Deciding missing is the host's
   * lookup against its live document list; absent → nothing is missing.
   */
  readonly missingFileRef?: (file: string) => boolean
  /**
   * Host controls (undo/redo/version history) docked as the palette's
   * leading group — the palette is the single bottom-chrome container.
   */
  readonly paletteLeading?: ReactNode
  /**
   * Reference CONTENT — an embedded canvas (J5a-2), an image (J5b), a
   * referenced markdown document's parsed body, a facet card. Must be
   * synchronous: hosts pre-fetch and cache, and an unresolved reference
   * returns undefined and the card renders. Absent → embeds never expand.
   *
   * Content only. The readable LABEL comes from `fileRefOptions` and the
   * dangling state from `missingFileRef`, both of which this component
   * layers on top — they are plain data, so they can cross to the layout
   * worker while this cannot, and keeping them apart is what lets a canvas
   * with labelled references still lay out off the main thread.
   *
   * A markdown body arrives parsed rather than raw so layout never runs a
   * markdown parse per file node per frame.
   */
  readonly resolveReference?: (ref: string) => ResolvedReference | undefined
  /**
   * Stores a picked/dropped/pasted image and returns the reference to put
   * in the created file node, or undefined on failure (nothing is
   * created). Absent → all image-creation affordances hide.
   */
  readonly onAddImage?: (file: File) => Promise<string | undefined>
  /**
   * Whether a file reference denotes a stored IMAGE asset rather than a
   * canvas. Image references get no canvas actions (follow, retarget) —
   * navigating to an asset reference is a dead end.
   */
  readonly isImageFileRef?: (file: string) => boolean
}

const EDGE_LABEL_EDITOR_WIDTH_PX = 160
const EDGE_LABEL_EDITOR_HEIGHT_PX = 28
/** The compose bubble sits where the saved comment's bubble will be drawn,
 * so committing reads as the draft settling rather than jumping. */
const COMMENT_COMPOSE_WIDTH_PX = 216
const COMMENT_COMPOSE_HEIGHT_PX = 64
/**
 * Where the draft opens: placed by canvas-render's own bubble placer over
 * the same obstacles, so it opens in the quadrant the settled bubble will
 * take rather than over the node the comment is about.
 */
function commentDraftBox(
  anchor: Point,
  obstacles: readonly BoundingBox[],
): { x: number; y: number; width: number; height: number } {
  const placed = placeCommentBubble(
    anchor,
    { w: COMMENT_COMPOSE_WIDTH_PX, h: COMMENT_COMPOSE_HEIGHT_PX },
    obstacles,
  )
  return { x: placed.x, y: placed.y, width: placed.w, height: placed.h }
}

/**
 * The compose bubble wears the theme's comment chrome — the same palette
 * entry, padding and corner the renderer draws the settled bubble with —
 * so the draft and the saved comment read as one object rather than a
 * plain editor a card replaces on commit. The shadow mirrors the SVG
 * drop-shadow filter (dy 1, blur ~3px at 30% black) that lifts the
 * settled chrome off the canvas plane.
 */
function commentComposeStyle(theme: ResolvedTheme): React.CSSProperties {
  const { bubble } = (theme === 'dark' ? SPATIAL_DARK_PALETTE : SPATIAL_LIGHT_PALETTE).comment
  return {
    background: bubble.fill,
    color: editorTextFill(theme),
    border: `1px solid ${bubble.stroke}`,
    borderRadius: COMMENT_BUBBLE_RADIUS_PX,
    padding: COMMENT_BUBBLE_PADDING_PX,
    // Focus is shown as a soft halo in the bubble's own stroke colour
    // rather than the UA's dark outline ring, which read as a second,
    // heavier border around the card. The bubble is only ever mounted
    // focused, so the halo is always the focus indicator.
    outline: 'none',
    boxShadow: `0 0 0 2px ${bubble.stroke}55, 0 1px 3px rgba(0, 0, 0, 0.3)`,
    fontFamily: SPATIAL_THEME_FONT_FAMILY,
    fontSize: BODY_FONT_SIZE_PX,
    lineHeight: `${BODY_LINE_HEIGHT_PX}px`,
    // Size to the draft like the settled bubble sizes to its text: one
    // line to start, growing as lines are added (`field-sizing`; browsers
    // without it keep the one-line minimum and scroll).
    height: 'auto',
    minHeight: BODY_LINE_HEIGHT_PX + 2 * COMMENT_BUBBLE_PADDING_PX + 2,
    ...({ fieldSizing: 'content' } as React.CSSProperties),
  }
}

/**
 * Opaque surface + label typography for the edge/group label editors. The
 * CSS reset makes form controls transparent, so without an explicit
 * background the object being edited (an edge line, the frame border)
 * shows through the draft.
 */
function labelEditorStyle(theme: ResolvedTheme) {
  return {
    background: theme === 'dark' ? 'oklch(0.145 0 0)' : '#ffffff',
    color: editorTextFill(theme),
    fontFamily: SPATIAL_THEME_FONT_FAMILY,
    fontSize: SPATIAL_THEME_GEOMETRY.labelFontSizePx,
  }
}
/** Screen-space px within which a press/right-click counts as hitting an
 * edge line; divided by the zoom for the canvas-space comparison. */
const EDGE_HIT_TOLERANCE_PX = 6

/**
 * Touch long-press → context menu. 500ms matches the platform long-press
 * feel (and Android's own contextmenu synthesis delay, so the two paths
 * agree on timing there); the slop is finger-sized jitter, not intent to
 * drag — past it the press is a drag and the menu must not interrupt.
 */
const LONG_PRESS_MENU_MS = 500
/**
 * The navigation machine distinguishes touch from everything else; pen
 * behaves as a mouse there, so this only has to be total, not faithful to
 * every platform's spelling.
 */
function navigationPointerKind(pointerType: string): PointerKind {
  return pointerType === 'touch' ? 'touch' : pointerType === 'pen' ? 'pen' : 'mouse'
}

const LONG_PRESS_SLOP_PX = 10
const DEFAULT_TEST_ID = 'spatial-editor'

/** Breathing room kept around framed content (zoom to fit / selection). */
const ZOOM_WHEEL_FACTOR = 1.1
function clientPointToRootLocal(e: { clientX: number; clientY: number }, root: HTMLElement) {
  const rect = root.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

/**
 * Pointer capture is best-effort chrome, not a correctness requirement: a
 * browser can reject it (e.g. `NotFoundError` for a pointerId the platform
 * has no active record of, which synthetic/programmatic pointer dispatch
 * can trigger). This component registers no window-level fallback
 * listeners, so a rejected/lost capture is instead recovered via
 * `onLostPointerCapture`, which cancels whatever gesture is in flight —
 * see its handler below.
 */
function trySetPointerCapture(root: HTMLElement, pointerId: number): void {
  try {
    root.setPointerCapture(pointerId)
  } catch {
    // best-effort — see doc comment above
  }
}

export const SpatialEditor = forwardRef<SpatialEditorHandle, SpatialEditorProps>(
  function SpatialEditor(
    {
      canvas,
      onChange,
      externalVersion,
      measure,
      createId,
      className,
      testId = DEFAULT_TEST_ID,
      theme = 'light',
      defaultTool = 'hand',
      initialTool,
      lockedNodeIds,
      lockedEdgeIds,
      agentTouchedNodeIds,
      onToggleEdgeLock,
      onToggleNodeLock,
      onOpenInEditor,
      threads,
      fileRefOptions,
      onOpenFileRef,
      missingFileRef,
      paletteLeading,
      resolveReference,
      onAddImage,
      isImageFileRef,
    },
    forwardedRef,
  ) {
    const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])
    const rootRef = useRef<HTMLDivElement | null>(null)

    const { shellRef, rootSize, inspectorIsSheet, viewportCenterScreen, containerSizeOf } =
      useEditorMeasurements(rootRef)

    const {
      selectionState,
      setSelectionState,
      applySelection,
      gestureState,
      setGestureState,
      gestureStateRef,
      livePoint,
      setLivePoint,
      snapGuides,
      setSnapGuides,
      doublePressRef,
      marquee,
      setMarquee,
      spaceDownRef,
      lastPressRef,
      activePointerIdRef,
      navigationRef,
      canvasRef,
      longPressRef,
      clearLongPress,
    } = useInteractionState({ canvas })
    const selectedId = selectionState.primaryId
    const {
      tool,
      setTool,
      toolChosenByUserRef,
      contextMenu,
      setContextMenu,
      longPressPulse,
      setLongPressPulse,
      openContextMenuAtRef,
    } = useToolState({ defaultTool, initialTool })
    /**
     * Additional selected node ids beyond the reducer's single primary
     * selection. Multi-select lives at the component layer on purpose: the
     * gesture reducer keeps its single-node contract, and group operations
     * expand into per-member commands at commit time (see the pointerup and
     * delete paths). Cleared whenever the primary selection clears.
     */
    const extraIds = selectionState.extraIds
    const { boxes, selectedBox, selectedNode } = useNodeBoxes({ canvas, selectedId })
    /** Narrowed pair so the overlay never has to assert a non-null `selectedId`. */
    const selection =
      selectedId !== null && selectedBox !== undefined
        ? { id: selectedId, box: selectedBox }
        : undefined
    // The pan/zoom viewport and its frame/zoom verbs — see
    // use-viewport-controls.ts. Wheel/hand/pinch navigation stays with the
    // pointer wiring below and drives the same setViewport.
    const { viewport, setViewport, stepZoom, frameContent, frameSelection } = useViewportControls({
      rootRef,
      boxes,
      selection,
      extraIds,
      viewportCenterScreen,
      containerSizeOf,
    })
    // The file-reference seam — the LOD gate, label/missing resolution and
    // the content cache — built once in useFileSeamScene and spread into
    // every scene-building call below (committed scene, drag ghost,
    // drag-static backdrop, resize preview).
    const { fileSeamOptions, missingFileRefs } = useFileSeamScene({
      canvas,
      zoom: viewport.zoom,
      resolveReference,
      fileRefOptions,
      missingFileRef,
      resolvedMeasure,
      theme,
    })
    // The COMMITTED scene, laid out in a worker when it can be. The drag
    // layers below keep their own synchronous paths: a gesture already has a
    // fast route through carried-side caching, and a round trip per frame
    // would be the wrong trade there. This is the path that blocks on every
    // node added and every drag dropped.
    // The node whose text the editor overlay owns: the scene keeps its
    // chrome and suppresses its body, so the overlay can be transparent and
    // a shaped node keeps its silhouette for the whole edit.
    const editingTextNodeId = gestureState.kind === 'editing-text' ? gestureState.nodeId : undefined
    const suppressedBodyNodeIds = useMemo(
      () => (editingTextNodeId === undefined ? undefined : [editingTextNodeId]),
      [editingTextNodeId],
    )
    // While that edit is open, keep its node above the virtual keyboard —
    // the keyboard overlays the page without resizing it, so this pan is
    // the only thing standing between edit mode and an invisible subject.
    useKeyboardAvoidance({
      editingBox: editingTextNodeId === undefined ? undefined : selection?.box,
      rootRef,
      containerSizeOf,
      setViewport,
    })
    const {
      showResolvedComments,
      setShowResolvedComments,
      selectedEdgeId,
      setSelectedEdgeId,
      pendingCut,
      setPendingCut,
      edgeLabelEditId,
      setEdgeLabelEditId,
      groupLabelEditId,
      setGroupLabelEditId,
      linkDialog,
      setLinkDialog,
      canvasPicker,
      setDocumentPicker,
      facetPanelOpen,
      setFacetPanelOpen,
    } = useEditSessionState({ canvas, selectedId })
    const { bounds, scene, anchors, sceneCurrent } = useWorkerScene(
      canvas,
      {
        measure: resolvedMeasure,
        theme,
        suppressedBodyNodeIds,
        showResolved: showResolvedComments,
      },
      fileSeamOptions,
      fileRefOptions,
      missingFileRefs,
    )
    const { keyed, edgePaths, commentChromeBoxes, selectionMembers, selectionBox, minimapNodes } =
      useSceneProjection({ scene, bounds, boxes, canvas, theme, selectedId, extraIds })
    const {
      commentPlacementObstacles,
      hitTestComment,
      commentById,
      toggleCommentCard,
      openCommentEditor,
      commentCompose,
      setCommentCompose,
      openCommentId,
      setOpenCommentId,
      pressedCommentRef,
      commentDrag,
      setCommentDrag,
    } = useCommentState({ canvasRef, commentChromeBoxes })
    // The committed surface without the comment in flight (see
    // keyedWithoutPrefix for why it leaves rather than hides).
    const draggedCommentId = commentDrag?.comment.id
    const surfaceKeyed = useMemo(
      () =>
        draggedCommentId === undefined ? keyed : keyedWithoutPrefix(keyed, `${draggedCommentId}/`),
      [keyed, draggedCommentId],
    )
    // Lock seams + coherence (predicates, selectable subset, and the two
    // effects that retire state a lock arrival invalidates) — see
    // use-lock-policy.ts.
    const { lockEnabled, isLocked, selectableBoxes, edgeLockEnabled, isEdgeLocked } = useLockPolicy(
      {
        boxes,
        lockedNodeIds,
        lockedEdgeIds,
        onToggleNodeLock,
        onToggleEdgeLock,
        selectedId,
        extraIds,
        selectedEdgeId,
        setSelectedEdgeId,
        setEdgeLabelEditId,
        gestureState,
        setGestureState,
        applySelection,
      },
    )
    // The controlled-prop-swap policy (gesture abort/continue + retiring
    // id-pinned state the new canvas no longer holds) — see
    // use-canvas-replacement.ts. Layout-effect timing lives there.
    useCanvasReplacement({
      canvas,
      externalVersion,
      gestureState,
      setGestureState,
      applySelection,
      setSelectedEdgeId,
      setLivePoint,
      setSnapGuides,
    })

    // The drag/resize/connect render layers (ghost, backdrop, live edges,
    // live resize, preview geometry, and the committed surface's mount-once
    // patch container) — one derivation hook, no state of its own. See
    // use-drag-layers.ts for the per-gesture vs per-frame split.
    const { dragContentSvg, dragStatic, dragPreview, liveEdges, liveNode, canvasContentRef } =
      useDragLayers({
        gestureState,
        canvas,
        extraIds,
        isLocked,
        lockEnabled,
        lockedNodeIds,
        resolvedMeasure,
        theme,
        fileSeamOptions,
        scene,
        anchors,
        keyed: surfaceKeyed,
        showResolved: showResolvedComments,
        boxes,
        selectableBoxes,
        livePoint,
      })

    useImperativeHandle(
      forwardedRef,
      () => ({
        setViewport,
        fitToContent(nodeIds) {
          const scoped = nodeIds === undefined ? boxes : boxes.filter((b) => nodeIds.includes(b.id))
          setViewport(fitViewportToBoxes(scoped.map((b) => b.box)))
        },
      }),
      [boxes],
    )

    const isMultiSelection = selectionMembers.length > 1

    /**
     * Folds `result.commands` in order over a LOCAL running canvas (seeded
     * from `canvasRef.current`, never re-read from the ref between steps) so
     * a multi-command result — e.g. a pending-text commit ordered ahead of a
     * create-node — can never lose its first command to a stale read. Each
     * command still gets its own `onChange` call, one canvas/command pair
     * per mutation, matching this component's pre-existing one-call-per-
     * command contract for the (still common) single-command case.
     */
    const applyResult = (result: ReturnType<typeof reduceGesture>) => {
      // Any gesture that leaves an in-flight state retires the preview: the
      // committed canvas is about to draw the real thing. Same predicate the
      // canvas-replaced effect above uses, so both agree on one definition.
      if (!isInFlightGesture(result.state)) {
        setLivePoint(null)
        // The guides justify an in-flight snap; outliving the gesture would
        // leave stray lines on the canvas.
        setSnapGuides(null)
      }
      setGestureState(result.state)
      if (result.selectedId !== undefined) {
        applySelection({ type: 'set-primary', id: result.selectedId })
        // A node becoming primary means no edge is selected. Enforced HERE,
        // at the one place a gesture result's selection is applied, rather
        // than by remembering `setSelectedEdgeId(null)` beside every call —
        // the omission this replaces let a double-click on empty space
        // create and select a note while an edge stayed selected, and
        // Delete answers the EDGE first.
        //
        // `null` is excluded deliberately: it means the gesture cleared the
        // node selection, which is the same `pointerdown-empty` the edge
        // hit-test uses to SELECT an edge. Clearing here would undo that
        // selection a line after it was made.
        if (result.selectedId !== null) setSelectedEdgeId(null)
      }
      let running = canvasRef.current
      for (const command of result.commands) {
        running = applyCommand(running, command)
        onChange(running, command)
        // Grow-only auto-fit: a committed body that lays out taller than the
        // stored box gets a follow-up resize so content never overflows the
        // border. Never shrinks — an authored roomy box (or manual enlarge)
        // is respected. Stored geometry stays truthful, so export (the same
        // layout over the same canvas) renders exactly what the editor shows.
        if (command.kind === 'set-text') {
          const node = running.nodes.find((n) => n.id === command.id)
          if (node !== undefined && node.type === 'text') {
            const required = Math.ceil(
              requiredTextNodeHeight(node, { measure: resolvedMeasure, theme }),
            )
            if (required > node.height) {
              const grow = {
                kind: 'resize-node',
                id: node.id,
                x: node.x,
                y: node.y,
                width: node.width,
                height: required,
              } as const
              running = applyCommand(running, grow)
              onChange(running, grow)
            }
          }
        }
      }
      // Written back HERE, not only from the canvas prop at re-render: two
      // commits landing in one tick (key auto-repeat, batched events) would
      // otherwise both compute from the pre-commit ref and the second would
      // clobber the first.
      canvasRef.current = running
    }

    /**
     * Takes pointer capture and records which pointer we hold it for, as one
     * step: the ref is what the unmount teardown effect releases from, so it
     * must never be updated independently of the capture itself.
     */
    const capturePointer = (root: HTMLElement, pointerId: number): void => {
      trySetPointerCapture(root, pointerId)
      activePointerIdRef.current = pointerId
    }

    /**
     * Arms the long-press menu for a single touch. Firing abandons whatever
     * the press started (a node move's 'pressing' state, marquee arming):
     * the press has become a menu invocation, not a drag.
     *
     * The navigation machine decides WHETHER to arm — hand mode never does,
     * because the press below it starts a pan and this teardown would strand
     * it mid-drag — and the timer itself stays here, where the menu, the
     * haptic and the pulse live.
     */
    const armLongPress = (pointerId: number, screen: Point) => {
      clearLongPress()
      longPressRef.current = {
        pointerId,
        screen,
        timer: setTimeout(() => {
          longPressRef.current = null
          if (gestureStateRef.current.kind !== 'idle') {
            applyResult(
              reduceGesture(gestureStateRef.current, canvasRef.current, {
                type: 'pointercancel',
              }),
            )
          }
          setMarquee(null)
          navigationRef.current = createIdleNavigation()
          gestureTrace.recordReset('long-press-menu', Math.round(performance.now()))
          lastPressRef.current = null
          doublePressRef.current = null
          // The native long-press this replaces gave a system haptic; keep
          // that cue so the menu opening under a still-down finger reads as
          // deliberate, not glitchy.
          hapticTick()
          setLongPressPulse(screen)
          openContextMenuAtRef.current(screen)
        }, LONG_PRESS_MENU_MS),
      }
    }

    /**
     * Hands one pointer event to the navigation machine and performs what it
     * asks for. Every effect maps to something this component already did at
     * the site the machine replaced; nothing new is invented here.
     */
    const runNavigation = (
      root: HTMLElement,
      event: NavigationEvent,
      at: number,
    ): NavigationResult => {
      const before = navigationRef.current
      const result = reduceNavigation(before, event)
      navigationRef.current = result.state
      gestureTrace.recordNavigation({ at: Math.round(at), event, before, result })
      for (const effect of result.effects) {
        switch (effect.kind) {
          case 'pan':
            setViewport((vp) => panBy(vp, effect.deltaScreen))
            break
          case 'zoom-at':
            setViewport((vp) => zoomAt(vp, effect.anchorScreen, effect.factor))
            break
          case 'pinch':
            setViewport((vp) =>
              zoomAt(panBy(vp, effect.panDeltaScreen), effect.anchorScreen, effect.factor),
            )
            break
          case 'capture':
            for (const pointerId of effect.pointerIds) capturePointer(root, pointerId)
            break
          case 'release-capture':
            activePointerIdRef.current = null
            break
          case 'arm-long-press':
            armLongPress(effect.pointerId, effect.screen)
            break
          case 'clear-long-press':
            clearLongPress()
            break
          case 'clear-marquee':
            setMarquee(null)
            break
          case 'clear-press-memory':
            lastPressRef.current = null
            doublePressRef.current = null
            break
          case 'cancel-manipulation':
            applyResult(reduceGesture(gestureState, canvas, { type: 'pointercancel' }))
            break
          case 'gather':
            toggleSelectionMember(effect.anchorPrimaryId, effect.hitId)
            break
        }
      }
      return result
    }

    /**
     * Shared prologue for the overlay's pointer handlers: take pointer capture
     * on the root and hand it back, or `null` when the root is not mounted.
     * (The overlay itself already stops propagation to the root's hit-test.)
     */
    const beginOverlayGesture = (e: React.PointerEvent): HTMLDivElement | null => {
      const root = rootRef.current
      if (root !== null) {
        // These presses never reach handlePointerDown, so this is where the
        // pointer joins the down set. Without it a capture lost mid-resize
        // would be read as an ordinary handback and never recovered. Their
        // release does reach handlePointerUp, because capture redirects the
        // rest of the sequence to the root.
        runNavigation(root, { type: 'external-press', pointerId: e.pointerId }, e.timeStamp)
        capturePointer(root, e.pointerId)
      }
      return root
    }

    /**
     * True when the event originated inside an overlay control (the Add
     * note button, the text editor, a future tool palette) rather than the
     * canvas surface. The root's gesture handlers must ignore those:
     * capturing the pointer on such a press retargets the subsequent
     * `click` to the capturing root, so the control's own onClick never
     * fires — a press on "Add note" silently did nothing. Overlay controls
     * opt in via `data-editor-overlay`; a per-control stopPropagation is
     * exactly the thing someone forgets (this bug), so the guard lives here
     * where forgetting is impossible.
     */
    const isOverlayEvent = (e: React.SyntheticEvent) =>
      e.target instanceof Element && e.target.closest('[data-editor-overlay]') !== null

    /**
     * Add or remove one node from the multi-selection, shared by shift-click
     * and the touch gather gesture so the two can never disagree about what
     * "already selected" means.
     *
     * `primaryId` is passed in rather than read from state because the gather
     * path learns the anchor from the in-flight gesture, whose `setSelectedId`
     * has not been applied yet when this runs.
     */
    const toggleSelectionMember = (primaryId: string | null, hitId: string) => {
      // Node and edge selection are mutually exclusive: Delete processes a
      // selected edge FIRST, so an edge left selected here would be what a
      // Delete on the node multi-selection actually removes.
      setSelectedEdgeId(null)
      // The caller supplies the anchor primary (the in-flight gesture's, not
      // yet applied); extras come from the latest state via the functional
      // update.
      setSelectionState((prev) =>
        reduceSelection(
          { primaryId, extraIds: prev.extraIds },
          { type: 'toggle-member', id: hitId },
        ),
      )
    }

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
      const hitId = hitTest(selectableBoxes, point)
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
      // A comment's chrome floats above content, so it is tested before the
      // nodes under it. A press on it never falls through to node or
      // marquee handling: a press that stays put OPENS the conversation at
      // the release, and one that travels drags the pin of a point-anchored
      // comment. A node-anchored comment's anchor IS its node's corner, so
      // its pin does not drag — moving the node is how it moves (and the
      // comment rides along).
      //
      // There is deliberately no double-press-to-edit here any more. A
      // single press now opens the card, whose own top-right Edit is the
      // successor: the second press of a pair would land on that card, which
      // stops propagation, so the pairing could never complete.
      const hitCommentId = hitTestComment(point)
      if (hitCommentId !== undefined) {
        const comment = commentById(hitCommentId)
        if (comment === undefined) return
        pressedCommentRef.current = comment.id
        if (comment.targetNodeId === undefined) {
          setCommentDrag({
            comment,
            startPoint: point,
            live: null,
            obstacles: commentPlacementObstacles(comment.id),
            dropped: null,
          })
        }
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
      if (e.shiftKey && hitId !== undefined) {
        toggleSelectionMember(selectedId, hitId)
        return
      }
      // Edge hit-test runs at the press so the double-press pairing can
      // distinguish "double-click on an edge" (open its label editor) from
      // "double-click on empty space" (create a node) — both have
      // hitId === undefined.
      // Locked edges are invisible to this hit-test, which is what keeps a
      // locked edge out of the selection and therefore out of Delete, the
      // label editor (double-press), and every restyle command.
      const hitEdge =
        hitId === undefined
          ? edgePaths.find(
              (edge) =>
                !isEdgeLocked(edge.id) &&
                distanceToPolyline(point, edge.path) <= EDGE_HIT_TOLERANCE_PX / viewport.zoom,
            )
          : undefined
      const pressKey = hitId ?? (hitEdge !== undefined ? `edge:${hitEdge.id}` : 'empty')
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
        if (hitEdge !== undefined) {
          setSelectedEdgeId(hitEdge.id)
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
      applyResult(
        reduceGesture(gestureState, canvas, { type: 'pointerdown', nodeId: hitId, point }),
      )
    }

    const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
      if (isOverlayEvent(e)) return
      // Replace the browser menu with the object's own action menu.
      e.preventDefault()
      const root = rootRef.current
      if (root === null) return
      openContextMenuAt(clientPointToRootLocal(e, root))
    }

    const openContextMenuAt = (screenPoint: Point) => {
      // Hand mode is navigation-ONLY: surfacing the edit menu on a touch
      // long-press there made phone panning fall into editing mid-gesture
      // (user report 2026-08-08). Switching to Select is the explicit gate
      // into editing affordances.
      if (tool === 'hand') return
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
      // The MENU hit-tests every node, locked included — a locked node has
      // to stay right-clickable or Unlock would be unreachable. Only the
      // selection side effect below is skipped for it.
      const hitId = hitTest(boxes, point)
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
      // Same edge tolerance as the click path: the object under the pointer
      // gets ITS menu, so an edge line must not read as empty space.
      const hitEdge =
        hitId === undefined
          ? edgePaths.find(
              (edge) =>
                distanceToPolyline(point, edge.path) <= EDGE_HIT_TOLERANCE_PX / viewport.zoom,
            )
          : undefined
      if (hitEdge !== undefined) {
        setSelectedEdgeId(hitEdge.id)
        applySelection({ type: 'clear' })
      }
      setContextMenu({
        x: screenPoint.x,
        y: screenPoint.y,
        nodeId: hitId,
        edgeId: hitEdge?.id,
        point,
      })
    }
    openContextMenuAtRef.current = openContextMenuAt

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const root = rootRef.current
      if (root === null) return
      // Movement past finger-jitter slop turns the press into a drag: the
      // armed long-press menu must not interrupt it.
      const armed = longPressRef.current
      if (armed !== null && armed.pointerId === e.pointerId) {
        const now = clientPointToRootLocal(e, root)
        if (Math.hypot(now.x - armed.screen.x, now.y - armed.screen.y) > LONG_PRESS_SLOP_PX) {
          clearLongPress()
        }
      }
      const screenPoint = clientPointToRootLocal(e, root)
      // First movement of an in-flight gesture: take capture now (see the
      // handlePointerDown comment for why not at the press). Idempotent —
      // re-capturing the same pointer is a no-op. Taken BEFORE the machine
      // reduces this move, so it reads the pan that the PRESS started rather
      // than the one this move is about to advance.
      if (
        activePointerIdRef.current === null &&
        (navigationRef.current.mode.kind === 'panning' ||
          gestureState.kind !== 'idle' ||
          commentDrag !== null)
      ) {
        capturePointer(root, e.pointerId)
      }
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
      if (commentDrag !== null) {
        if (commentDrag.dropped !== null) return
        setCommentDrag({ ...commentDrag, live: screenToCanvas(screenPoint, viewport) })
        return
      }
      if (marquee !== null) {
        setMarquee({ start: marquee.start, current: screenToCanvas(screenPoint, viewport) })
        return
      }
      if (gestureState.kind === 'idle') return
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
      applyResult(
        reduceGesture(gestureState, canvas, { type: 'pointermove', point: snapped.point }),
      )
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
      // A release the machine answered was navigation — a finger leaving a
      // gather or a pinch, or the end of a pan. None of them run the click
      // and marquee semantics below: the sequence was never a gesture on the
      // canvas, and treating its release as one would re-collapse the very
      // selection the gather just built.
      if (!navigation.fallThrough) return
      // Consumed here whatever happens next, so a press on a comment can
      // never open its card two gestures later.
      const pressedComment = pressedCommentRef.current
      pressedCommentRef.current = null
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
      if (pressedComment !== null) {
        // A node-anchored comment arms no drag, so its release arrives here.
        toggleCommentCard(pressedComment)
        return
      }
      const armed = doublePressRef.current
      doublePressRef.current = null
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
        const hitIds = selectableBoxes
          .filter(
            (entry) =>
              entry.box.x < rect.x + rect.w &&
              entry.box.x + entry.box.width > rect.x &&
              entry.box.y < rect.y + rect.h &&
              entry.box.y + entry.box.height > rect.y,
          )
          .map((entry) => entry.id)
        applySelection({ type: 'set-members', ids: hitIds })
        // A drag that began on an edge line was a marquee, not an edge click
        // — drop the press-time edge selection so Delete acts on the nodes.
        setSelectedEdgeId(null)
        return
      }
      if (root === null) return
      const screenPoint = clientPointToRootLocal(e, root)
      // Snapped with the same helper the preview used, so the box commits
      // exactly where the last frame drew it.
      const point = snapGesturePoint(
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
      ).point
      const targetNodeId =
        gestureState.kind === 'connecting' ? hitTest(selectableBoxes, point) : undefined
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
        if (node?.type === 'text') {
          applyResult(
            reduceGesture(result.state, canvas, {
              type: 'start-text-edit',
              nodeId: node.id,
              text: node.text,
            }),
          )
          return
        }
        // A link node's double press follows the reference, mirroring the
        // text node's double-press-edits rule: the object's primary action.
        if (node?.type === 'link') {
          applyResult(result)
          openLinkNode(node)
          return
        }
        // A group's double press edits its label — the frame's one own datum.
        if (node?.type === 'group') {
          applyResult(result)
          setGroupLabelEditId(node.id)
          return
        }
        // A file node's double press follows the reference (navigate), the
        // same primary-action rule as link nodes. Image references are not
        // followable — navigating to an asset id is a dead end.
        if (
          node?.type === 'file' &&
          onOpenFileRef !== undefined &&
          isImageFileRef?.(node.file) !== true &&
          missingFileRef?.(node.file) !== true
        ) {
          applyResult(result)
          onOpenFileRef(node.file, node.subpath)
          return
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
      // release would read the stale id and open that comment's card.
      pressedCommentRef.current = null
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

    /**
     * The selection as reorder targets, primary + extras, deduped. The
     * command treats ids as a set and takes relative order from the canvas.
     */
    const reorderSelection = (placement: 'forward' | 'backward' | 'front' | 'back') => {
      if (selection === undefined) return false
      const command: EditorCommand = {
        kind: 'reorder-nodes',
        ids: [selection.id, ...extraIds],
        placement,
      }
      // `running` is the purity-guard-approved onChange argument shape: the
      // canvas produced by applyCommand, never a hand-built object.
      const running = applyCommand(canvasRef.current, command)
      // Total command: extremes return the input — emit no empty history step.
      if (running !== canvasRef.current) onChange(running, command)
      return true
    }

    /**
     * Applies a set of moves as ONE batch command — an align is one user
     * action and must undo as one step. An empty move list (already aligned)
     * emits nothing rather than an empty history entry, matching
     * `reorderSelection`'s totality contract.
     */
    const applyBoxMoves = (moves: readonly BoxMove[]): boolean => {
      if (moves.length === 0) return true
      const command: EditorCommand = {
        kind: 'batch',
        commands: moves.map((move) => ({ kind: 'move-node' as const, ...move })),
      }
      const running = applyCommand(canvasRef.current, command)
      if (running !== canvasRef.current) onChange(running, command)
      return true
    }

    /**
     * The selection seam for the clipboard family: make exactly these nodes
     * the selection (primary first) and drop any edge selection, through
     * the same reducer every other selection write uses.
     */
    const selectNodes = (ids: readonly string[]): void => {
      applySelection({ type: 'set-members', ids: [...ids] })
      setSelectedEdgeId(null)
    }
    const {
      duplicateSelection,
      copySelection,
      cutSelection,
      createTextNodeAtViewportCenter,
      pasteClipboard,
      pasteFragment,
    } = useClipboardActions({
      canvasRef,
      primaryId: selection?.id,
      extraIds,
      pendingCut,
      setPendingCut,
      onChange,
      createId,
      selectNodes,
      viewport,
      viewportCenterScreen,
    })

    /**
     * Select every node; the first becomes primary, the rest extras.
     * Always returns true, INCLUDING on an empty canvas: returning false
     * would let the chord fall through to the browser's own select-all,
     * highlighting the whole page. A handled no-op still consumes it.
     */

    const handleWheel = (e: WheelEvent) => {
      const root = rootRef.current
      if (root === null) return
      // React registers onWheel as a PASSIVE listener (matching the browser's
      // own default for scroll-affecting events), so e.preventDefault() from a
      // React handler is silently ignored. Ctrl/Cmd+wheel zoom needs to
      // suppress the browser's own page-zoom/scroll, which only a
      // { passive: false } NATIVE listener can do — see the effect below that
      // wires this function up that way.
      e.preventDefault()
      const screenPoint = clientPointToRootLocal(e, root)
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR
        setViewport((vp) => zoomAt(vp, screenPoint, factor))
        return
      }
      // A scroll wheel moves the CONTENT opposite to a drag of the same sign,
      // hence the negated delta.
      setViewport((vp) => panBy(vp, { x: -e.deltaX, y: -e.deltaY }))
    }

    useNativeCanvasListeners(rootRef, handleWheel, longPressRef, activePointerIdRef)

    /** Creates a text node centered on `point` (canvas space) and opens it for typing. */
    const createNodeAt = (point: Point) => {
      applyResult(
        reduceGesture(gestureState, canvas, { type: 'dblclick-empty', point }, { createId }),
      )
      // Creation selects the new node EXCLUSIVELY. The double-press path
      // collapsed the extras at its empty press already; the palette path
      // never presses the canvas, so old extras would ride along into the
      // next move/delete without this.
      applySelection({ type: 'collapse-extras' })
    }

    /**
     * The button path (unlike double-click, whose point comes straight from
     * the pointer) always resolves to the same viewport-center point, so
     * without a placement rule every click here would stack an identical,
     * unreachable rect on the last one. `findFreeSpot` cascades off the
     * CURRENT node boxes (read from `canvasRef.current`, not the possibly-
     * stale `canvas` prop) so two rapid clicks still see each other's result.
     */
    /**
     * Pans so the union of all node boxes sits centered in the viewport,
     * keeping the current zoom (the hand-mode "where did my content go"
     * recovery). No boxes → no-op.
     */
    // The keyboard surface — shortcut dispatch plus the three keydown
    // handlers the JSX wires (canvas root, focused resize handle, connect
    // handle). See use-editor-keyboard.ts; shortcuts.ts stays the catalog.
    const { handleKeyDown, handleResizeHandleKeyDown, handleConnectKeyDown } = useEditorKeyboard({
      tool,
      canvas,
      canvasRef,
      gestureState,
      selection,
      selectedNode,
      extraIds,
      selectedEdgeId,
      setSelectedEdgeId,
      pendingCut,
      setPendingCut,
      spaceDownRef,
      lockEnabled,
      edgeLockEnabled,
      isLocked,
      isEdgeLocked,
      onToggleNodeLock,
      onToggleEdgeLock,
      onChange,
      applyResult,
      applySelection,
      duplicateSelection,
      reorderSelection,
      stepZoom,
      frameContent,
      frameSelection,
    })

    /** Places one of the directly-creatable kinds at a canvas-space point. */
    const createAt = (kind: DraggableCreation, point: Point) => {
      if (kind === 'note') createNodeAt(point)
      else createGroupAtViewportCenter(point)
    }

    const createNodeAtViewportCenter = () => {
      const preferred = screenToCanvas(viewportCenterScreen(), viewport)
      const occupied = indexNodeBoxes(canvasRef.current).map((b) => b.box)
      const point = findFreeSpot(
        preferred,
        { width: NEW_NODE_WIDTH, height: NEW_NODE_HEIGHT },
        occupied,
        visibleCanvasRect(),
      )
      createNodeAt(point)
      panToShow({
        x: Math.round(point.x - NEW_NODE_WIDTH / 2),
        y: Math.round(point.y - NEW_NODE_HEIGHT / 2),
        width: NEW_NODE_WIDTH,
        height: NEW_NODE_HEIGHT,
      })
    }

    const {
      visibleCanvasRect,
      panToShow,
      createLinkAtViewportCenter,
      createFileRefAtViewportCenter,
      addImageFile,
      createGroupAtViewportCenter,
      groupSelection,
    } = useNodeCreation({
      rootRef,
      canvasRef,
      viewport,
      setViewport,
      createId,
      fileRefOptions,
      onAddImage,
      applyResult,
      collapseExtras: () => applySelection({ type: 'collapse-extras' }),
      containerSizeOf,
    })

    const imageInputRef = useRef<HTMLInputElement | null>(null)
    /** When set, the next picked image becomes this group's background instead of a new node. */
    const pendingBackgroundGroupIdRef = useRef<string | null>(null)
    /** Where the pending picker-created image should land; null = viewport center. */
    const pendingImagePointRef = useRef<Point | null>(null)

    /** The one place a stored URL is turned into navigation. noopener keeps
     * the canvas tab unreachable from the opened page, and the scheme guard
     * holds HERE (not only in the dialog) because documents arrive via sync
     * and import — a hostile javascript:/data: URL must never reach
     * window.open. */
    const openLinkNode = (node: Extract<SpatialNode, { type: 'link' }>) => {
      if (!isFollowableUrl(node.url)) return
      window.open(node.url, '_blank', 'noopener,noreferrer')
    }

    return (
      // The inspector is a SIBLING of the canvas, not an overlay on it. The
      // root IS the pointer surface — every screenToCanvas reads its rect —
      // so anything drawn over it swallows the press regardless of what the
      // canvas does about it. Measured before this: the dock covered
      // 540..892 of a 900px editor and a node under it could not be selected.
      <div
        ref={shellRef}
        className={`select-none ${className ?? ''}`.trimEnd()}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: inspectorIsSheet ? 'column' : 'row',
        }}
      >
        <div
          ref={rootRef}
          data-testid={testId}
          // The canvas is a drawing surface, not prose: a drag means marquee or
          // pan, and Select All means every NODE. Leaving it text-selectable let
          // the browser paint its own selection across the chrome — reported
          // after a Select All. Text stays selectable where text is edited (see
          // TextNodeEditor).
          // A canvas editor's interaction surface has no static-content semantics
          // HTML/ARIA can describe more precisely than "application" — this is
          // the same documented tradeoff drawing/whiteboard editors commonly
          // make. A dedicated a11y parallel-DOM projection is future work, not
          // this slice's scope.
          role="application"
          aria-label="Spatial canvas editor"
          // Click-focusable (not tab-reachable): edge selection focuses this
          // root programmatically so real keyboard events reach onKeyDown.
          tabIndex={-1}
          style={{
            position: 'relative',
            flex: '1 1 auto',
            // Without these a flex item refuses to shrink below its content,
            // and the gutter would come out of the page instead of the canvas.
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
            touchAction: 'none',
            outline: 'none',
            cursor: tool === 'hand' ? 'grab' : undefined,
          }}
          onPointerDown={handlePointerDown}
          onContextMenu={handleContextMenu}
          // Image intake: drop anywhere on the canvas, or paste — both route
          // through the same host storage seam as the picker.
          onDragOver={(e) => {
            if (draggedCreation(e.dataTransfer.types) !== null) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              return
            }
            if (onAddImage !== undefined && e.dataTransfer.types.includes('Files')) {
              e.preventDefault()
            }
          }}
          onDrop={(e) => {
            const dragged = draggedCreation(e.dataTransfer.types)
            if (dragged !== null) {
              e.preventDefault()
              const root = rootRef.current
              if (root === null) return
              const local = clientPointToRootLocal(e, root)
              createAt(dragged, screenToCanvas(local, viewport))
              return
            }
            if (onAddImage === undefined) return
            if (e.dataTransfer.files.length === 0) return
            // Cancel the browser's default file-drop handling (navigation to
            // the file) for EVERY file drop, then only act on images.
            e.preventDefault()
            const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'))
            if (file === undefined) return
            const root = rootRef.current
            if (root === null) return
            const local = clientPointToRootLocal(e, root)
            addImageFile(file, screenToCanvas(local, viewport))
          }}
          // The clipboard family rides the NATIVE events, not keydown: a
          // keydown preventDefault on Cmd+C/X/V suppresses the very event
          // carrying `clipboardData`, and that data is what crosses tabs and
          // what lets foreign text degrade into a note.
          onCopy={(e) => {
            if (isTextEntryEvent(e.nativeEvent)) return
            const fragment = copySelection()
            if (fragment === null) return
            e.preventDefault()
            e.clipboardData?.setData('text/plain', JSON.stringify(fragment))
          }}
          onCut={(e) => {
            if (isTextEntryEvent(e.nativeEvent)) return
            const fragment = cutSelection()
            if (fragment === null) return
            e.preventDefault()
            e.clipboardData?.setData('text/plain', JSON.stringify(fragment))
          }}
          onPaste={(e) => {
            if (isTextEntryEvent(e.nativeEvent)) return
            // Content cascade (Excalidraw's shape): image file, then our own
            // JSON, then any other text as a note. Only a completely empty
            // clipboard falls through untouched.
            const file = [...(e.clipboardData?.files ?? [])].find((f) =>
              f.type.startsWith('image/'),
            )
            if (file !== undefined) {
              if (onAddImage === undefined) return
              e.preventDefault()
              addImageFile(file)
              return
            }
            const text = e.clipboardData?.getData('text/plain') ?? ''
            const parsed = parseClipboardText(text)
            if (parsed !== null) {
              e.preventDefault()
              pasteFragment(parsed)
              return
            }
            if (text.trim() !== '') {
              e.preventDefault()
              createTextNodeAtViewportCenter(text)
              return
            }
            // Nothing recognizable in the event — fall back to the in-app
            // slot, which is what a same-tab Cmd+V carries in browsers that
            // hand us an empty clipboardData for a canvas paste.
            if (pasteClipboard()) e.preventDefault()
          }}
          onKeyUp={(e) => {
            if (e.key === ' ') spaceDownRef.current = false
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handleLostPointerCapture}
          onKeyDown={handleKeyDown}
        >
          {(() => {
            // Drawn only when the threads plane can answer for it: the
            // canvas comment alone holds one message, and a card that
            // showed a conversation's first line and called it the whole
            // conversation would be worse than no card.
            //
            // SCREEN space, outside the pan/zoom transform, for two
            // reasons that both bit. The transform layer is its own
            // stacking context BELOW the minimap's z-10, so a card drawn
            // inside it had every action swallowed by the minimap when the
            // comment sat near the bottom-right corner — measured, and no
            // z-index on the card can lift it out of its parent's context.
            // And a card is chrome, not content: its controls are tap
            // targets with a screen size, so scaling them with the zoom
            // was wrong even where it was reachable.
            if (openCommentId === null || commentCompose !== null) return null
            const thread = threads?.find((entry) => entry.id === openCommentId)
            const bubble = commentChromeBoxes.find(
              (entry) => entry.commentId === openCommentId && entry.part === 'bubble',
            )
            if (thread === undefined || bubble === undefined) return null
            return (
              <CommentThreadCard
                // Keyed by THREAD, so moving to another conversation mounts a
                // fresh card. Without it React reuses this one instance and
                // its unsent draft survives the switch — the next submit would
                // append the first thread's text to the second, since the
                // handler closes over the new id.
                key={thread.id}
                thread={thread}
                box={(() => {
                  const at = canvasToScreen({ x: bubble.bbox.x, y: bubble.bbox.y }, viewport)
                  return { x: at.x, y: at.y, width: bubble.bbox.w * viewport.zoom, height: 0 }
                })()}
                style={commentComposeStyle(theme)}
                onReply={(body) =>
                  applyResult({
                    state: { kind: 'idle' },
                    commands: [
                      {
                        kind: 'reply-to-thread',
                        threadId: thread.id,
                        message: {
                          id: (createId ?? defaultCreateId)(),
                          body,
                          // No author: this app has no accounts, so there
                          // is no name to write that would not be invented.
                          createdAt: new Date().toISOString(),
                        },
                      } as const,
                    ],
                  })
                }
                onResolve={(resolved) =>
                  applyResult({
                    state: { kind: 'idle' },
                    commands: [{ kind: 'set-comment-resolved', id: thread.id, resolved } as const],
                  })
                }
                onEdit={() => {
                  const comment = commentById(thread.id)
                  if (comment === undefined) return
                  setOpenCommentId(null)
                  openCommentEditor(comment)
                }}
                onClose={() => setOpenCommentId(null)}
              />
            )
          })()}
          {/* Screen space, outside the pan/zoom transform — an overview that
          panned with the canvas would defeat its purpose.
          It stays up during a drag: `data-editor-overlay` already stops a
          press on it reaching the canvas, so hiding bought nothing and cost
          a flicker on every gesture. Hidden only on an empty canvas, where
          an overview of nothing is chrome with no job. */}
          {boxes.length > 0 && rootSize.width >= MINIMAP_MIN_ROOT_WIDTH_PX && (
            <MinimapOverlay
              boxes={minimapNodes}
              viewportRect={{
                x: viewport.x,
                y: viewport.y,
                width: rootSize.width / viewport.zoom,
                height: rootSize.height / viewport.zoom,
              }}
              width={MINIMAP_WIDTH_PX}
              height={MINIMAP_HEIGHT_PX}
              onNavigate={(point: { x: number; y: number }) =>
                setViewport((vp) => ({
                  ...vp,
                  x: point.x - rootSize.width / vp.zoom / 2,
                  y: point.y - rootSize.height / vp.zoom / 2,
                }))
              }
            />
          )}
          {longPressPulse !== null && (
            // The moment the long-press commits: one expanding ring at the
            // pressed point. Haptics are best-effort at most (see
            // haptics.ts), so this is the feedback channel that always works;
            // removed on its own animationend (the reduced-motion floor
            // shortens, never cancels, so cleanup still fires).
            //
            // OUTSIDE the pan/zoom transform, unlike the canvas-space
            // overlays: the coordinates are root-local screen px, and a
            // fixed-size feedback ring must not scale with zoom.
            <div
              data-testid="long-press-pulse"
              aria-hidden="true"
              className="long-press-pulse"
              style={{ left: longPressPulse.x, top: longPressPulse.y }}
              onAnimationEnd={() => setLongPressPulse(null)}
            />
          )}
          {/* The OOUI creation surface: every canvas is empty until a node
          exists and double-click-empty-space has no visible cue, so the
          palette is the always-visible, keyboard-reachable way in. Fixed to
          the bottom edge outside the pan/zoom transform. */}
          {pendingCut !== null && (
            <PendingCutChip
              count={pendingCut.snapshot.size}
              coarse={hasCoarsePointer()}
              onCancel={() => setPendingCut(null)}
            />
          )}
          <ToolPalette
            // The dock does NOT change with the mode. Navigation belongs to the
            // viewport, not to whichever tool is armed, so nothing is exchanged
            // for entering hand mode — the host's history cluster stays put and
            // the one view control (zoom to fit) is always in the same place.
            leading={paletteLeading}
            onZoomToFit={frameContent}
            onCreateNode={createNodeAtViewportCenter}
            onCreateLink={() => setLinkDialog({ mode: 'create' })}
            onCreateGroup={createGroupAtViewportCenter}
            onCreateDocumentRef={
              fileRefOptions === undefined ? undefined : () => setDocumentPicker({ mode: 'create' })
            }
            onCreateImage={
              onAddImage === undefined
                ? undefined
                : () => {
                    pendingImagePointRef.current = null
                    imageInputRef.current?.click()
                  }
            }
            tool={tool}
            onToolChange={(next) => {
              setTool(next)
              toolChosenByUserRef.current = true
              // A stated preference outranks the canvas-shape guess on the
              // next open in this tab.
              writeLastTool(next)
              // A context menu is an edit affordance of the mode it was
              // opened in — switching tools (especially into view-only hand
              // mode) must not leave it floating.
              setContextMenu(null)
              // Entering hand mode drops EVERY edit affordance, not just the
              // menu: a surviving selection would keep Delete/resize/connect
              // handles live, an open editor would keep accepting text, and
              // an armed connect could still complete — all edits in a mode
              // whose contract is "no press can change the canvas". The
              // in-flight gesture is cancelled like Escape (uncommitted text
              // is discarded, not committed).
              if (next === 'hand') {
                if (gestureState.kind !== 'idle') {
                  applyResult(reduceGesture(gestureState, canvas, { type: 'pointercancel' }))
                }
                applySelection({ type: 'clear' })
                setSelectedEdgeId(null)
                setEdgeLabelEditId(null)
                setGroupLabelEditId(null)
                setMarquee(null)
              }
            }}
          />
          {onAddImage !== undefined && (
            <input
              ref={imageInputRef}
              data-editor-overlay
              data-testid="image-file-input"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file === undefined) return
                const backgroundGroupId = pendingBackgroundGroupIdRef.current
                pendingBackgroundGroupIdRef.current = null
                if (backgroundGroupId !== null) {
                  if (onAddImage === undefined || !file.type.startsWith('image/')) return
                  void onAddImage(file).then((ref) => {
                    if (ref !== undefined) {
                      applyResult({
                        state: { kind: 'idle' },
                        commands: [
                          { kind: 'set-group-background', id: backgroundGroupId, background: ref },
                        ],
                      })
                    }
                  })
                  return
                }
                addImageFile(file, pendingImagePointRef.current ?? undefined)
                pendingImagePointRef.current = null
              }}
            />
          )}
          {contextMenu !== null && (
            <CanvasContextMenu
              commands={{
                applyResult,
                applyBoxMoves,
                copySelection,
                cutSelection,
                pasteClipboard,
                duplicateSelection,
                reorderSelection,
                groupSelection,
                createNodeAt,
                createGroupAtViewportCenter,
                openLinkNode,
                onOpenFileRef,
                onAddImage,
                onToggleNodeLock,
                onToggleEdgeLock,
                setEdgeLabelEditId,
                setGroupLabelEditId,
                setSelectedEdgeId,
                setLinkDialog,
                setDocumentPicker,
                setFacetPanelOpen,
                setCommentCompose,
                showResolvedComments,
                setShowResolvedComments,
              }}
              contextMenu={contextMenu}
              setContextMenu={setContextMenu}
              canvas={canvas}
              canvasRef={canvasRef}
              theme={theme}
              gestureState={gestureState}
              isEdgeLocked={isEdgeLocked}
              fileRefOptions={fileRefOptions}
              pendingImagePointRef={pendingImagePointRef}
              imageInputRef={imageInputRef}
              pendingBackgroundGroupIdRef={pendingBackgroundGroupIdRef}
              isLocked={isLocked}
              extraIds={extraIds}
              selectedId={selectedId}
              isImageFileRef={isImageFileRef}
              missingFileRef={missingFileRef}
            />
          )}
          {canvasPicker !== null &&
            fileRefOptions !== undefined &&
            // A retarget edits ONE node, so it may not outlive it: an undo,
            // an import or a peer's delete can take the node while the
            // dialog is open, and `set-node-file` for a node that is gone
            // is a no-op the user cannot see. Resolved in the render like
            // the two label editors below rather than cleared by an effect
            // — a gate the dialog cannot render without passing is one no
            // future canvas-changing path can forget.
            (canvasPicker.mode === 'create' ||
              canvas.nodes.some((node) => node.id === canvasPicker.nodeId)) && (
              <DocumentPickerDialog
                title={
                  canvasPicker.mode === 'create'
                    ? `Add ${CREATION_LABELS.document}`
                    : 'Change target'
                }
                options={fileRefOptions}
                currentFile={
                  canvasPicker.mode === 'retarget'
                    ? (() => {
                        const target = canvas.nodes.find((n) => n.id === canvasPicker.nodeId)
                        return target?.type === 'file' ? target.file : undefined
                      })()
                    : undefined
                }
                onPick={(file) => {
                  if (canvasPicker.mode === 'create') {
                    createFileRefAtViewportCenter(file, canvasPicker.point)
                  } else {
                    applyResult({
                      state: { kind: 'idle' },
                      commands: [{ kind: 'set-node-file', id: canvasPicker.nodeId, file }],
                    })
                  }
                  setDocumentPicker(null)
                }}
                onCancel={() => setDocumentPicker(null)}
              />
            )}
          {linkDialog !== null &&
            // Same rule as the picker above: an Edit URL that outlived its
            // link shows an empty field and writes nothing on OK.
            (linkDialog.mode === 'create' ||
              canvas.nodes.some((node) => node.id === linkDialog.nodeId)) && (
              <LinkUrlDialog
                title={linkDialog.mode === 'create' ? `Add ${CREATION_LABELS.link}` : 'Edit URL'}
                initialUrl={
                  linkDialog.mode === 'edit'
                    ? (() => {
                        const target = canvas.nodes.find((n) => n.id === linkDialog.nodeId)
                        return target?.type === 'link' ? target.url : undefined
                      })()
                    : undefined
                }
                onSubmit={(url) => {
                  if (linkDialog.mode === 'create') {
                    createLinkAtViewportCenter(url, linkDialog.point)
                  } else {
                    applyResult({
                      state: { kind: 'idle' },
                      commands: [{ kind: 'set-node-url', id: linkDialog.nodeId, url }],
                    })
                  }
                  setLinkDialog(null)
                }}
                onCancel={() => setLinkDialog(null)}
              />
            )}
          <div
            data-testid="viewport-transform"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              transform: viewportTransformCss(viewport),
              transformOrigin: '0 0',
              // canvas-render's layoutMdastBlocks assigns no appearance to
              // markdown body text runs (they carry no `fill` attribute at
              // all), so they inherit it from whichever ancestor sets one —
              // the seam that keeps body text visible on the dark canvas
              // surface without editing canvas-render itself. It sits on the
              // shared ancestor of EVERY canvas-space layer rather than on
              // the committed one, because the live drag layers host the same
              // markup: set on the committed layer alone, a dragged node's
              // body text fell back to the UA default black and read as
              // vanishing for the length of the gesture. Any element that DOES
              // carry its own `fill` presentation attribute is unaffected
              // (presentation attributes win over an inherited value), which
              // is every shape the selection overlay draws.
              fill: editorTextFill(theme),
            }}
          >
            <div
              data-testid="canvas-content"
              style={{
                position: 'absolute',
                left: (dragStatic?.bounds ?? bounds).x,
                top: (dragStatic?.bounds ?? bounds).y,
              }}
              // Mount-once keyed patching (use-keyed-svg.ts): every byte that
              // lands in this container is still canvas-render's serializer
              // output — the patcher only decides WHICH groups to replace —
              // so CanvasViewer.tsx's single-producer injection reasoning
              // carries over unchanged, and untouched groups keep their DOM
              // nodes across commits (selection, focus, animations survive).
              ref={canvasContentRef}
            />
            {liveEdges !== undefined && (
              <div
                data-testid="live-edges"
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: liveEdges.bounds.x,
                  top: liveEdges.bounds.y,
                  pointerEvents: 'none',
                }}
                // Same trusted producer as the committed scene (canvas-render's
                // escaping serializer).
                // biome-ignore lint/security/noDangerouslySetInnerHtml: same trusted producer as the committed scene
                dangerouslySetInnerHTML={{ __html: liveEdges.svg }}
              />
            )}
            {liveNode !== undefined && (
              <div
                data-testid="live-node"
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: liveNode.bounds.x,
                  top: liveNode.bounds.y,
                  pointerEvents: 'none',
                }}
                // Same trusted producer as the committed scene (canvas-render's
                // escaping serializer).
                // biome-ignore lint/security/noDangerouslySetInnerHtml: same trusted producer as the committed scene
                dangerouslySetInnerHTML={{ __html: liveNode.svg }}
              />
            )}
            {/* Editor-only iframe embeds for link nodes (never in exports).
              Rides the same transform as every canvas-space overlay; the
              LOD gate mirrors the canvas-embed thresholds. */}
            <LinkEmbedLayer
              canvas={canvas}
              interactive={tool !== 'hand'}
              shouldOffer={(node) =>
                node.width * viewport.zoom >= EXPAND_MIN_W &&
                node.height * viewport.zoom >= EXPAND_MIN_H
              }
            />
            {marquee !== null && <MarqueeOverlay marquee={marquee} zoom={viewport.zoom} />}
            {snapGuides !== null && (
              <SnapGuidesOverlay guides={snapGuides} boxes={boxes} zoom={viewport.zoom} />
            )}
            {/* Which nodes are in the selection. The overlay above outlines the
            region the handles act on, which says nothing about membership —
            outlining only the extras left the primary looking untouched, so a
            Select All over three nodes read as though it had skipped one.
            Hidden while a move is in flight: every member travels with the
            ghost, so these outlines (boxes and internal-edge highlights,
            both derived from the committed scene) would mark geometry that
            is no longer drawn there. */}
            {pendingCut !== null && (
              <GhostOverlay
                boxes={canvas.nodes.flatMap((n) =>
                  pendingCut.snapshot.has(n.id)
                    ? [{ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }]
                    : [],
                )}
                zoom={viewport.zoom}
              />
            )}
            {isMultiSelection && gestureState.kind !== 'moving' && (
              <MemberOutlinesOverlay
                selectionMembers={selectionMembers}
                edges={canvas.edges}
                edgePaths={edgePaths}
                zoom={viewport.zoom}
              />
            )}
            {/* The same drawing as above in a different colour: "these boxes,
            outlined". `edges` is empty on purpose — an agent reports the
            edges it touched, but an edge outline is far less legible than a
            box one and the nodes are what actually moved. Add it if edge-only
            batches turn out to be a real case. */}
            {agentTouchedNodeIds !== undefined && agentTouchedNodeIds.size > 0 && (
              <MemberOutlinesOverlay
                testId="agent-touch-outlines"
                stroke="var(--accent-foreground)"
                selectionMembers={boxes.filter((entry) => agentTouchedNodeIds.has(entry.id))}
                edges={[]}
                edgePaths={[]}
                zoom={viewport.zoom}
              />
            )}
            {selection !== undefined && selectionBox !== undefined && (
              <SelectionOverlay
                // Keyed by TARGET: a new selection remounts the overlay and
                // replays the outline's draw-once; dragging or resizing the
                // same node keeps the element and stays still.
                key={selection.id}
                box={selectionBox}
                zoom={viewport.zoom}
                onHandlePointerDown={(handle, _handleBox, e) => {
                  const root = beginOverlayGesture(e)
                  if (root === null) return
                  const point = screenToCanvas(clientPointToRootLocal(e, root), viewport)
                  applyResult(
                    reduceGesture(gestureState, canvas, {
                      type: 'pointerdown-handle',
                      nodeId: selection.id,
                      handle,
                      point,
                      // The resize anchor is the box the HANDLES surround, not
                      // the handle's own tiny hit-box `_handleBox` describes —
                      // using the handle box here would seed
                      // `reducePointerUpResizing`'s anchor-preserving math from
                      // an 8px square instead, growing/shrinking from the wrong
                      // origin.
                      box: selectionBox,
                      // Omitted for a lone node, which keeps the original
                      // single-command path — including its collapse-to-zero
                      // behavior, which group members deliberately do not share.
                      ...(isMultiSelection ? { members: selectionMembers } : {}),
                    }),
                  )
                }}
                // Connecting and editing act on ONE node; from handles that
                // surround a group they would claim to apply to all of them.
                onConnectPointerDown={
                  isMultiSelection
                    ? undefined
                    : (e) => {
                        if (beginOverlayGesture(e) === null) return
                        applyResult(
                          reduceGesture(gestureState, canvas, {
                            type: 'pointerdown-connect',
                            nodeId: selection.id,
                          }),
                        )
                      }
                }
                onHandleKeyDown={handleResizeHandleKeyDown}
                onConnectKeyDown={handleConnectKeyDown}
                // The ⋯ opens the SAME menu right-click does, for the same
                // target — one catalog, now with a visible doorway. Offered
                // for every selection (multi included: align/distribute were
                // the least discoverable actions of all).
                // Only a single text node has a body to open, and only when the
                // host has a surface to open it on.
                onOpenInEditor={
                  onOpenInEditor !== undefined && !isMultiSelection && selectedNode?.type === 'text'
                    ? () => onOpenInEditor(selectedNode.id, selectedNode.text)
                    : undefined
                }
                onMoreActions={(anchor) => {
                  const screen = canvasToScreen(anchor, viewport)
                  setContextMenu({
                    x: screen.x,
                    y: screen.y,
                    nodeId: selection.id,
                    edgeId: undefined,
                    point: anchor,
                    // The ⋯ vessel follows the editor's width, decided at open
                    // time (the menu is transient): below the minimap
                    // breakpoint the popover becomes a bottom sheet — keyed
                    // off the CONTAINER for the same reason the minimap is.
                    variant: rootSize.width < MINIMAP_MIN_ROOT_WIDTH_PX ? 'sheet' : 'grid',
                  })
                }}
              />
            )}
            {/* In-flight gesture preview. Drawn from component-local pointer
            state above the committed SVG, so the expensive
            layout+stringify+innerHTML path runs once per gesture (at
            pointerup) instead of once per frame. */}
            {dragPreview !== undefined && (
              <DragPreviewLayer
                preview={dragPreview}
                zoom={viewport.zoom}
                contentSvg={dragContentSvg}
              />
            )}
            {/* Rendered for the WHOLE drag, not only once a live point
                exists. The committed copy leaves the surface the moment the
                drag starts (`surfaceKeyed` above), so gating the preview on
                `live` left the comment in neither place until the first
                pointermove — it vanished. Worst on touch, where a long-press
                starts the drag and a finger held still sends no move. Before
                the pointer travels the delta is zero, which draws the preview
                exactly over the anchor it was pressed at. */}
            {commentDrag !== null && (
              <CommentDragLayer
                comment={commentDrag.comment}
                delta={{
                  x: (commentDrag.live?.x ?? commentDrag.startPoint.x) - commentDrag.startPoint.x,
                  y: (commentDrag.live?.y ?? commentDrag.startPoint.y) - commentDrag.startPoint.y,
                }}
                measure={resolvedMeasure}
                theme={theme}
                obstacles={commentDrag.obstacles}
              />
            )}
            {selectedEdgeId !== null && (
              <EdgeSelectionHighlight selectedEdgeId={selectedEdgeId} edgePaths={edgePaths} />
            )}
            {gestureState.kind === 'connecting' && (
              <ConnectOverlay
                gestureState={gestureState}
                canvas={canvas}
                boxes={boxes}
                selectableBoxes={selectableBoxes}
                createId={createId}
                applyResult={applyResult}
              />
            )}
            {edgeLabelEditId !== null &&
              (() => {
                const edge = canvas.edges.find((entry) => entry.id === edgeLabelEditId)
                const path = edgePaths.find((entry) => entry.id === edgeLabelEditId)?.path
                if (edge === undefined || path === undefined) return null
                // edgePaths is already the DRAWN (flattened) line, so the
                // shared anchor needs no second rounding pass here.
                const mid = edgeLabelAnchor(path)
                if (mid === undefined) return null
                return (
                  <TextNodeEditor
                    exitHintScale={1 / viewport.zoom}
                    box={{
                      x: mid.x - EDGE_LABEL_EDITOR_WIDTH_PX / 2,
                      y: mid.y - EDGE_LABEL_EDITOR_HEIGHT_PX / 2,
                      width: EDGE_LABEL_EDITOR_WIDTH_PX,
                      height: EDGE_LABEL_EDITOR_HEIGHT_PX,
                    }}
                    initialText={edge.label ?? ''}
                    testId="edge-label-editor"
                    style={labelEditorStyle(theme)}
                    onCommit={(label) => {
                      applyResult({
                        state: { kind: 'idle' },
                        commands: [
                          { kind: 'set-edge-label', id: edge.id, label: label.trim() } as const,
                        ],
                      })
                      setEdgeLabelEditId(null)
                    }}
                    onCancel={() => setEdgeLabelEditId(null)}
                  />
                )
              })()}
            {groupLabelEditId !== null &&
              (() => {
                const group = canvas.nodes.find((entry) => entry.id === groupLabelEditId)
                if (group === undefined || group.type !== 'group') return null
                return (
                  <TextNodeEditor
                    exitHintScale={1 / viewport.zoom}
                    // The label renders OUTSIDE, above the frame (container
                    // convention) — the editor sits on that band.
                    box={{ x: group.x, y: group.y - 44, width: group.width, height: 40 }}
                    initialText={group.label ?? ''}
                    testId="group-label-editor"
                    style={labelEditorStyle(theme)}
                    onCommit={(label) => {
                      applyResult({
                        state: { kind: 'idle' },
                        commands: [
                          { kind: 'set-group-label', id: group.id, label: label.trim() } as const,
                        ],
                      })
                      setGroupLabelEditId(null)
                    }}
                    onCancel={() => setGroupLabelEditId(null)}
                  />
                )
              })()}
            {commentCompose !== null && (
              <TextNodeEditor
                exitHintScale={1 / viewport.zoom}
                box={commentDraftBox(
                  commentCompose.point,
                  commentPlacementObstacles(commentCompose.editing?.id),
                )}
                initialText={commentCompose.editing?.initialText ?? ''}
                testId="comment-compose"
                style={commentComposeStyle(theme)}
                onCommit={(draft) => {
                  const text = draft.trim()
                  // A blank commit is a cancel: an empty comment says nothing
                  // and would still ask the reader to resolve it. Editing an
                  // existing comment to blank likewise keeps its stored text —
                  // removal stays MCP-only in v1 (ADR-0025).
                  if (commentCompose.editing !== undefined) {
                    if (text.length > 0 && text !== commentCompose.editing.initialText) {
                      applyResult({
                        state: { kind: 'idle' },
                        commands: [
                          {
                            kind: 'set-comment-text',
                            id: commentCompose.editing.id,
                            text,
                          } as const,
                        ],
                      })
                    }
                  } else if (text.length > 0) {
                    const { point, targetNodeId } = commentCompose
                    applyResult({
                      state: { kind: 'idle' },
                      commands: [
                        {
                          kind: 'create-comment',
                          comment: {
                            id: (createId ?? defaultCreateId)(),
                            // Rounded for the same reason the pin drag rounds:
                            // an integer by schema, and a fractional anchor
                            // is dropped on read rather than rejected here.
                            x: Math.round(point.x),
                            y: Math.round(point.y),
                            text,
                            createdAt: new Date().toISOString(),
                            ...(targetNodeId === undefined ? {} : { targetNodeId }),
                          },
                        } as const,
                      ],
                    })
                  }
                  setCommentCompose(null)
                }}
                onCancel={() => setCommentCompose(null)}
              />
            )}
            {gestureState.kind === 'editing-text' &&
              selectedNode?.type === 'text' &&
              selection !== undefined && (
                <MarkdownNodeEditor
                  // The scene keeps drawing this node's chrome (its body is
                  // suppressed while this editor is open), so the editor is
                  // TRANSPARENT and sits in the same box the committed text
                  // uses: the silhouette's inscribed content box. A shaped
                  // node therefore keeps its silhouette for the whole edit,
                  // and the text does not jump on entering edit mode.
                  box={(() => {
                    const chrome = scene.nodes.find(
                      (entry) => entry.kind === 'shape' && entry.id === selectedNode.id,
                    )
                    const shapeId =
                      chrome !== undefined && chrome.kind === 'shape' ? chrome.shape : undefined
                    const bbox = {
                      x: selection.box.x,
                      y: selection.box.y,
                      w: selection.box.width,
                      h: selection.box.height,
                    }
                    const inner = outlineContentBox(shapeId, bbox)
                    return { x: inner.x, y: inner.y, width: inner.w, height: inner.h }
                  })()}
                  initialText={selectedNode.text}
                  exitHintTop={selection.box.y + selection.box.height + 6}
                  exitHintScale={1 / viewport.zoom}
                  centerContent={scene.nodes.some(
                    (entry) =>
                      entry.kind === 'shape' &&
                      entry.id === selectedNode.id &&
                      entry.shape !== undefined,
                  )}
                  style={{
                    // Transparent once the scene below has stopped drawing
                    // this node's text. An offloaded canvas lags one worker
                    // round trip behind the suppression change, so for that
                    // gap the overlay keeps the old opaque cover — otherwise
                    // the committed text shows doubled under the draft.
                    background: sceneCurrent
                      ? 'transparent'
                      : (() => {
                          const fill =
                            createEditorAppearance(theme).resolveNode(selectedNode).appearance?.fill
                          return fill !== undefined && fill !== 'none'
                            ? fill
                            : theme === 'dark'
                              ? 'oklch(0.145 0 0)'
                              : '#ffffff'
                        })(),
                    color: editorTextFill(theme),
                    fontFamily: SPATIAL_THEME_FONT_FAMILY,
                    fontSize: BODY_FONT_SIZE_PX,
                    // The overlay must advance by the SAME line box the
                    // committed render uses, or the text moves under the
                    // cursor on entering edit mode. Shared constant, not a
                    // second copy of the number — these were equal until the
                    // markdown theme took body line height to 1.5.
                    lineHeight: `${BODY_LINE_HEIGHT_PX}px`,
                    padding: SPATIAL_THEME_GEOMETRY.paddingPx,
                  }}
                  onCommit={(text) => {
                    applyResult(
                      reduceGesture(gestureState, canvas, { type: 'commit-text-edit', text }),
                    )
                  }}
                  onCancel={() => {
                    applyResult(reduceGesture(gestureState, canvas, { type: 'cancel-text-edit' }))
                  }}
                  onChange={(text) => {
                    applyResult(
                      reduceGesture(gestureState, canvas, { type: 'update-text-edit', text }),
                    )
                  }}
                />
              )}
          </div>
        </div>
        {facetPanelOpen &&
          (() => {
            const target = canvas.nodes.find((entry) => entry.id === selectedId)
            // Nothing selected: the inspector is ABOUT a node, so there is
            // nothing for it to be about. It closes rather than standing
            // there saying so — the same thing a press on blank canvas does
            // to the context menu, which is the semantic this matches. The
            // flag is cleared during render just above, so re-opening it
            // later is an ordinary open rather than a stuck true.
            if (target === undefined) return null
            return (
              <FacetFormPanel
                node={target}
                registry={bundledFacetRegistry}
                variant={inspectorIsSheet ? 'sheet' : 'dock'}
                onWrite={(key, payload) => {
                  // Applies to the whole selection, the semantics the menu
                  // bands had: reshaping five selected nodes must not become
                  // five visits to this panel.
                  const members = new Set(selectedId !== null ? [selectedId, ...extraIds] : [])
                  const ids = members.has(target.id) ? [...members] : [target.id]
                  applyResult({
                    state: { kind: 'idle' },
                    commands: ids.map((id) => ({
                      kind: 'set-node-facet' as const,
                      id,
                      key,
                      payload,
                    })),
                  })
                }}
              />
            )
          })()}
      </div>
    )
  },
)
