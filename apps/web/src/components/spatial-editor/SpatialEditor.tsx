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

import type { MeasureText, ReferenceWire } from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import type {
  CanvasEdge,
  CanvasLine,
  CommentThread,
  Proposal,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import { nodeFile, nodeKind, nodeText, nodeUrl } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry, type TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { editThreadMessageCommand } from '../../hooks/spatial-thread-write.js'
import {
  useEditingFontFamily,
  useThemeFaceFor,
  useThemeFontsGeneration,
} from '../../hooks/useThemeFonts.js'
import { parseClipboardText } from '../../lib/clipboard-fragment.js'
import type { EditorTool } from '../../lib/editor-tool.js'
import { hapticTick } from '../../lib/haptics.js'
import { writeLastTool } from '../../lib/initial-tool.js'
import type { FileRefOption } from '../../lib/link-entries.js'
import { hasCoarsePointer } from '../../lib/platform.js'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { applyCommand } from '../../lib/spatial/commands.js'
import type { SpatialEditorHandle } from '../../lib/spatial/editor-handle.js'
import { defaultCreateId } from '../../lib/spatial/element-id.js'
import { findFreeSpot, hitTest, indexNodeBoxes } from '../../lib/spatial/geometry.js'
import { requiredTextNodeHeight } from '../../lib/spatial/scene-render.js'
import { keyedWithoutPrefix } from '../../lib/spatial/scene-render-core.js'
import type { PreviousStroke } from '../../lib/spatial/stroke-group.js'
import { collectCanvasTags, retag } from '../../lib/spatial/tags.js'
import {
  canvasToScreen,
  clientPointToRootLocal,
  fitViewportToBoxes,
  type Point,
  panBy,
  proposalAt,
  screenToCanvas,
  viewportRevealingProposal,
  viewportTransformCss,
  zoomAt,
} from '../../lib/spatial/viewport.js'
import type { ResolvedTheme } from '../../lib/theme.js'
import { type BoxMove, boxMoveCommand } from './align.js'
import { BoxTargetOverlay } from './BoxTargetOverlay.js'
import { CanvasContextMenu } from './CanvasContextMenu.js'
import { CommentDragLayer } from './CommentDragLayer.js'
import { CommentThreadCard } from './CommentThreadCard.js'
import { CommentComposeOverlay, commentComposeStyle } from './comment-compose-overlay.js'
import { CREATION_LABELS } from './creation-labels.js'
import { DocumentPickerDialog } from './DocumentPickerDialog.js'
import { DragPreviewLayer } from './DragPreviewLayer.js'
import { isInFlightGesture } from './drag-preview.js'
import { EdgeBendLayer } from './EdgeBendLayer.js'
import { EdgeEndHandles } from './EdgeEndHandles.js'
import { EdgeSelectionHighlight } from './EdgeSelectionHighlight.js'
import { isEditorOverlayTarget } from './editor-overlay.js'
import { FacetFormPanel } from './facet-widgets/FacetFormPanel.js'
import { collectFieldSuggestions } from './facet-widgets/field-suggestions.js'
import { isFollowableUrl } from './followable-url.js'
import { GhostOverlay } from './GhostOverlay.js'
import { otherEndNodeOf } from './gesture-ends.js'
import { gestureTrace } from './gesture-trace.js'
import { NEW_NODE_HEIGHT, NEW_NODE_WIDTH, reduceGesture } from './gestures.js'
import { InkDraftLayer } from './InkDraftLayer.js'
import { LegendOverlay } from './LegendOverlay.js'
import { LinkEmbedLayer } from './LinkEmbedLayer.js'
import { LinkUrlDialog } from './LinkUrlDialog.js'
import { EdgeLabelEditorOverlay, GroupLabelEditorOverlay } from './label-editor-overlays.js'
import { MarqueeOverlay } from './MarqueeOverlay.js'
import { MemberOutlinesOverlay } from './MemberOutlinesOverlay.js'
import { MinimapOverlay } from './MinimapOverlay.js'
import { MarkdownBodyEditorOverlay } from './markdown-body-editor-overlay.js'
import {
  createIdleNavigation,
  type NavigationEvent,
  type NavigationResult,
  reduceNavigation,
} from './navigation.js'
import { PendingCutChip } from './PendingCutChip.js'
import { ProposalCard } from './ProposalCard.js'
import { SelectionOverlay } from './SelectionOverlay.js'
import { SnapGuidesOverlay } from './SnapGuidesOverlay.js'
import { reduceSelection } from './selection.js'
import { isTextEntryEvent } from './shortcuts.js'
import { type DraggableCreation, draggedCreation, ToolPalette } from './ToolPalette.js'
import { useCanvasReferences } from './use-canvas-references.js'
import { useCanvasReplacement } from './use-canvas-replacement.js'
import { useClipboardActions } from './use-clipboard-actions.js'
import { useCommentState } from './use-comment-state.js'
import { useDragLayers } from './use-drag-layers.js'
import { useEditSessionState } from './use-edit-session-state.js'
import { useEditorKeyboard } from './use-editor-keyboard.js'
import { MINIMAP_MIN_ROOT_WIDTH_PX, useEditorMeasurements } from './use-editor-measurements.js'
import { useEditorPointer } from './use-editor-pointer.js'
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
   * The workspace's tag library (ADR-0040 decision 5), when the keeper
   * answered one: a box or an edge carrying a value it colours, and no
   * colour of its own, is drawn in that colour and the legend lists the key;
   * every tag row offers its values and refuses what it forbids.
   */
  readonly tagLibrary?: TagLibrary
  /** Tags in use anywhere in the workspace, offered by every tag row beside the board's own. */
  readonly tagSuggestions?: readonly string[]
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
   * This document's open proposals (ADR-0029 decision 1), drawn on the live
   * canvas: an outline where each change would land, and one bubble per
   * proposal. Absent, nothing proposal-shaped is drawn — a host with no
   * proposal channel has nothing to show.
   */
  readonly proposals?: readonly Proposal[]
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
   * Content only, as DATA: the loaded reference graph with its alias,
   * title and extras tables. The readable LABEL comes from `fileRefOptions`
   * and the dangling state from `missingFileRef`, layered on top. This
   * component builds the reference bundle from the wire for its own
   * thread and posts the wire to the layout worker, which builds the same
   * bundle from the same bytes — so what a text node embeds and what a file
   * node shows cannot differ between the two.
   */
  readonly references?: ReferenceWire
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
const DEFAULT_TEST_ID = 'spatial-editor'
/** Screen distance between two points — how far a press travelled. */

/** Breathing room kept around framed content (zoom to fit / selection). */
const ZOOM_WHEEL_FACTOR = 1.1
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
      tagLibrary,
      tagSuggestions,
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
      proposals,
      fileRefOptions,
      onOpenFileRef,
      missingFileRef,
      paletteLeading,
      references,
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
    // What THIS canvas can read of the host's wider wire, by identity.
    const { wire: canvasWire, seams } = useCanvasReferences(canvas, references)
    // The file-reference seam — the LOD gate, label/missing resolution and
    // the content cache — built once in useFileSeamScene and spread into
    // every scene-building call below (committed scene, drag ghost,
    // drag-static backdrop, resize preview).
    const { fileSeamOptions, missingFileRefs, expandedFileIds } = useFileSeamScene({
      canvas,
      zoom: viewport.zoom,
      references: seams,
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
    // Whatever text entry has focus inside the root — a node's editor, the
    // comment compose bubble, a label, the thread card's reply box — stays
    // above the virtual keyboard: the keyboard overlays the page without
    // resizing it, so this pan is the only thing standing between typing
    // and an invisible subject. Focus-driven, so no editor has to be wired.
    useKeyboardAvoidance({ rootRef, containerSizeOf, setViewport })
    const {
      showResolvedComments,
      setShowResolvedComments,
      selectedEdgeId,
      setSelectedEdgeId,
      selectedInkIds,
      setSelectedInkIds,
      retainInk,
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
    const fontsGeneration = useThemeFontsGeneration()
    useThemeFaceFor(canvas)
    const editingFontFamily = useEditingFontFamily(canvas)
    const { bounds, scene, anchors, sceneCurrent } = useWorkerScene(
      canvas,
      {
        measure: resolvedMeasure,
        theme,
        suppressedBodyNodeIds,
        showResolved: showResolvedComments,
        threads,
        proposals,
        tagLibrary,
        fontsGeneration,
      },
      fileSeamOptions,
      { fileRefLabels: fileRefOptions, missingFileRefs, references: canvasWire, expandedFileIds },
    )
    const {
      keyed,
      palette,
      edgePaths,
      commentChromeBoxes,
      proposalChromeBoxes,
      selectionMembers,
      selectionBox,
      minimapNodes,
    } = useSceneProjection({ scene, bounds, boxes, canvas, theme, selectedId, extraIds })
    /**
     * The routed path of an edge, as drawn — for a comment about an edge to
     * open its bubble on the path (canvas-render's `commentAnchor`), the
     * same producer the layer pins it with.
     */
    /**
     * How near a press has to land to count as on a drawn path, in CANVAS
     * units: the budget is a screen distance, so zooming out widens it in
     * document space and the stroke stays as easy to hit with a finger.
     */
    /**
     * What the last committed stroke left behind, for the next press to be
     * judged against. A ref rather than state: nothing renders from it, and
     * the press that reads it runs before React could have committed a
     * setState from the release that wrote it.
     */
    const lastStrokeRef = useRef<PreviousStroke | null>(null)
    const inkTolerance = EDGE_HIT_TOLERANCE_PX / viewport.zoom
    const edgePathOf = useCallback(
      (edgeId: string) => edgePaths.find((entry) => entry.id === edgeId)?.path,
      [edgePaths],
    )
    // Named for the TYPE it holds rather than for the state that keys it:
    // `selectedEdgeId` may name a relation or a stroke, because the scene
    // hands both out as the same kind of node. Looking in `canvas.edges`
    // alone is what left a selected stroke with no bend affordance at all.
    const selectedRoutable: CanvasEdge | CanvasLine | undefined =
      selectedEdgeId === null
        ? undefined
        : (canvas.edges.find((edge) => edge.id === selectedEdgeId) ??
          (canvas.lines ?? []).find((line) => line.id === selectedEdgeId))
    const {
      commentPlacementObstacles,
      hitTestComment,
      commentById,
      toggleCommentCard,
      commentCompose,
      setCommentCompose,
      openCommentId,
      setOpenCommentId,
      pressedCommentRef,
      commentDrag,
      setCommentDrag,
    } = useCommentState({ canvasRef, commentChromeBoxes })
    /**
     * The proposal opened in place — at most one, for the reason a
     * conversation is: a card is where ONE thing is decided.
     */
    const [openProposalId, setOpenProposalId] = useState<string | null>(null)
    /**
     * The proposal a press landed on, read back at the release. Same
     * discipline as a comment's press and for the same reason — in hand
     * mode navigation takes every plain press as a pan and never hands it
     * back — minus the drag: a proposal's bubble is placed by the renderer
     * from the changes it describes, so there is nothing to move it to.
     */
    const pressedProposalRef = useRef<{ readonly id: string; readonly startScreen: Point } | null>(
      null,
    )
    const hitTestProposal = (point: Point): string | undefined =>
      proposalAt(proposalChromeBoxes, point)
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
        retainInk,
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
      retainInk,
      setLivePoint,
      setSnapGuides,
    })

    /**
     * Everything a press or a band needs to know about the board, in the one
     * shape `element-pick.ts` builds its probes from. The editor supplies
     * DATA; which kinds are contended for, in what order, and with which
     * probe is that module's — so the property judging those decisions
     * judges the ones this component actually runs, rather than a copy of
     * them written in a test.
     */
    const pickInputs = {
      paths: edgePaths,
      edges: canvas.edges,
      boxes,
      tolerance: inkTolerance,
      isNodeLocked: isLocked,
      isEdgeLocked,
    }
    /**
     * The same board, as the MENU sees it: every node and every path, locked
     * included. A locked object has to stay right-clickable or Unlock would
     * be unreachable — only the selection side effect is skipped for it.
     */
    const menuPickInputs = { ...pickInputs, isNodeLocked: () => false, isEdgeLocked: () => false }

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
        tagLibrary,
        fileSeamOptions,
        scene,
        anchors,
        sceneCurrent,
        keyed: surfaceKeyed,
        commentInFlight: draggedCommentId !== undefined,
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
        openProposal(proposalId) {
          const at = viewportRevealingProposal(proposalChromeBoxes, proposalId)
          if (at === null) return false
          setViewport(at)
          setOpenProposalId(proposalId)
          return true
        },
      }),
      [boxes, proposalChromeBoxes],
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
      // The mirror is advanced HERE as well as at render, because a handler
      // that runs before React re-renders would otherwise reduce against the
      // previous gesture. It matters for exactly one gesture — a stroke,
      // which accumulates rather than recomputing from its start — and the
      // browser delivers `pointermove` faster than React commits.
      gestureStateRef.current = result.state
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
          if (node !== undefined && nodeText(node) !== undefined) {
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
     * The navigation machine decides WHETHER to arm (a second finger never
     * does), and the timer itself stays here, where the menu, the haptic
     * and the pulse live. Under the hand tool the press below started a
     * pan; a finger still enough for the timer to fire never advanced it,
     * so the teardown strands nothing — a finger that moves clears the
     * timer before it can fire (see handlePointerMove).
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
          // The press is spent on the menu: the release that follows must
          // not ALSO open the card of the comment or proposal it landed on.
          pressedCommentRef.current = null
          pressedProposalRef.current = null
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
            // A second finger made this a pinch; the comment or proposal
            // under the first is not being opened.
            pressedCommentRef.current = null
            pressedProposalRef.current = null
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
     * fires — a press on "Add note" silently did nothing. The answer is
     * `isEditorOverlayTarget`, shared with the native touch refuser so the
     * two guards cannot disagree about what chrome is; a per-control
     * stopPropagation is exactly the thing someone forgets (this bug), so
     * the guard lives here where forgetting is impossible.
     */
    const isOverlayEvent = (e: React.SyntheticEvent) => isEditorOverlayTarget(e.target)

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
      // NOTHING is dropped here. It used to clear the whole path selection,
      // because Delete processed the selected edge FIRST and would have
      // removed that instead of the node multi-selection — a real hazard
      // while the two could not go together. Delete takes every selected
      // stroke AND the nodes in one press now, so the reason is gone, and
      // with it the reason to shrink a selection the person is growing:
      // this is the shared path of shift-click and the touch gather, and
      // shift means ADD everywhere else in this editor.
      //
      // A relation EDGE went on being dropped after ink stopped being,
      // because the verbs behind an edge dispatched to a single target —
      // `toggle-lock` would have locked the one surviving relation instead
      // of the nodes being gathered. Those verbs take the set now (user
      // decision, 2026-09-19), so the distinction has nothing left to rest
      // on and an edge is kept like a stroke.
      //
      // A plain press still replaces — that clearing lives on the press
      // paths, not here. The caller supplies the anchor primary (the
      // in-flight gesture's, not yet applied); extras come from the latest
      // state via the functional update.
      setSelectionState((prev) =>
        reduceSelection(
          { primaryId, extraIds: prev.extraIds },
          { type: 'toggle-member', id: hitId },
        ),
      )
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
      const command: EditorCommand = { kind: 'batch', commands: moves.map(boxMoveCommand) }
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
      selectedInkIds,
      pendingCut,
      setPendingCut,
      onChange,
      createId,
      selectNodes,
      selectInk: setSelectedInkIds,
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
      setSelectedEdgeId,
      selectedInkIds,
      setSelectedInkIds,
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
    const openLinkNode = (node: SpatialNode) => {
      const url = nodeUrl(node)
      if (url === undefined || !isFollowableUrl(url)) return
      window.open(url, '_blank', 'noopener,noreferrer')
    }

    const {
      handlePointerDown,
      handleContextMenu,
      handlePointerMove,
      handlePointerUp,
      handlePointerCancel,
      handleLostPointerCapture,
    } = useEditorPointer({
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
    })

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
            // The paper is the palette's surface for the UI mode (ADR-0030):
            // a theme carries one per mode, and the bundled palette's is the
            // page background, so an unthemed canvas looks exactly as before.
            backgroundColor: palette.surface,
            // Without these a flex item refuses to shrink below its content,
            // and the gutter would come out of the page instead of the canvas.
            minWidth: 0,
            minHeight: 0,
            // `clip`, not `hidden`: a hidden-overflow box is still a scroll
            // container, and the browser scrolls one silently to reveal a
            // focused control — tapping a reply box on a card that overhung
            // the bottom edge shifted the whole canvas 38px under a viewport
            // state that knew nothing about it, and the keyboard pan then
            // aimed at where the card had been. `clip` forbids that scroll
            // outright; the viewport is the only thing that moves the canvas.
            overflow: 'clip',
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
                style={commentComposeStyle(palette)}
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
                onEditMessage={(messageId, body) => {
                  const command = editThreadMessageCommand(thread, messageId, body)
                  if (command === null) return
                  applyResult({ state: { kind: 'idle' }, commands: [command] })
                }}
                onClose={() => setOpenCommentId(null)}
              />
            )
          })()}
          {(() => {
            // The proposal opened in place, in SCREEN space and above the
            // ambient chrome for the reasons the comment card states.
            if (openProposalId === null) return null
            const proposal = proposals?.find((entry) => entry.id === openProposalId)
            const bubble = proposalChromeBoxes.find((entry) => entry.proposalId === openProposalId)
            if (proposal === undefined || bubble === undefined) return null
            return (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                canvas={canvas}
                box={(() => {
                  const at = canvasToScreen({ x: bubble.bbox.x, y: bubble.bbox.y }, viewport)
                  return { x: at.x, y: at.y, width: bubble.bbox.w * viewport.zoom, height: 0 }
                })()}
                palette={palette}
                onDecide={(decision, changes) => {
                  // Closed here rather than waiting for the write to come
                  // back: the card asked a question that has been answered,
                  // and leaving it up over a board that just changed reads
                  // as the press not having landed.
                  setOpenProposalId(null)
                  applyResult({
                    state: { kind: 'idle' },
                    commands: [
                      {
                        kind: 'decide-proposal',
                        proposalId: proposal.id,
                        decision,
                        // Exactly what the card decided — its whole open set,
                        // or the single row that was pressed. The card owns
                        // that reading, so there is nothing here to re-derive
                        // and nothing for the two to disagree about.
                        changes,
                      } as const,
                    ],
                  })
                }}
                onClose={() => setOpenProposalId(null)}
              />
            )
          })()}
          {/* Screen space, outside the pan/zoom transform — an overview that
          panned with the canvas would defeat its purpose.
          It stays up during a drag: `data-editor-overlay` already stops a
          press on it reaching the canvas, so hiding bought nothing and cost
          a flicker on every gesture. Hidden only on an empty canvas, where
          an overview of nothing is chrome with no job. */}
          {/* What the board's colour MEANS, as the layout attached it to the
          scene (ADR-0040 decision 6). Screen space like the minimap; the keyed
          projection omits its SVG twin, so the corner is drawn once. */}
          {scene?.legend !== undefined && <LegendOverlay legend={scene.legend} />}
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
              selectedInkIds={selectedInkIds}
              createId={createId ?? defaultCreateId}
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
                        return target === undefined ? undefined : nodeFile(target)
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
                        return target === undefined ? undefined : nodeUrl(target)
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
              fill: palette.labelFill,
            }}
          >
            <div
              data-testid="canvas-content"
              className="canvas-surface"
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
            {gestureState.kind === 'drawing' && (
              <InkDraftLayer
                points={gestureState.points}
                zoom={viewport.zoom}
                stroke={palette.edgeStroke}
              />
            )}
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
                  onOpenInEditor !== undefined &&
                  !isMultiSelection &&
                  selectedNode !== undefined &&
                  nodeKind(selectedNode) === 'text'
                    ? () => onOpenInEditor(selectedNode.id, nodeText(selectedNode) ?? '')
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
            {selectedInkIds.length > 0 && (
              <EdgeSelectionHighlight
                selectedEdgeIds={selectedInkIds}
                edgePaths={edgePaths}
                // The live half of the ink drag: the committed strokes stay
                // where they are and their outlines travel, which is the
                // same bargain the node drag makes with its ghost box. A
                // full re-layout per frame is what the preview overlay
                // exists to avoid (see `drag-preview.ts`'s header).
                offset={
                  gestureState.kind === 'moving-ink'
                    ? {
                        x: (livePoint?.x ?? gestureState.startPoint.x) - gestureState.startPoint.x,
                        y: (livePoint?.y ?? gestureState.startPoint.y) - gestureState.startPoint.y,
                      }
                    : undefined
                }
              />
            )}
            {selectedRoutable !== undefined && (
              <EdgeEndHandles
                path={edgePathOf(selectedRoutable.id) ?? []}
                zoom={viewport.zoom}
                onArm={(endpoint, event) => {
                  if (event !== undefined) beginOverlayGesture(event)
                  applyResult(
                    reduceGesture(gestureState, canvas, {
                      type: 'pointerdown-end',
                      elementId: selectedRoutable.id,
                      endpoint,
                    }),
                  )
                }}
              />
            )}
            {selectedRoutable !== undefined && (
              <EdgeBendLayer
                edge={selectedRoutable}
                path={edgePathOf(selectedRoutable.id) ?? []}
                viewport={viewport}
                begin={beginOverlayGesture}
                dispatch={(event) => applyResult(reduceGesture(gestureState, canvas, event))}
              />
            )}
            {(gestureState.kind === 'connecting' || gestureState.kind === 'reattaching') && (
              <BoxTargetOverlay
                gestureState={gestureState}
                sourceNodeId={
                  gestureState.kind === 'connecting'
                    ? gestureState.fromNodeId
                    : // The box the OTHER end is on, which this end may not
                      // land on either: the write refuses a self-loop, so
                      // offering it as a target would offer a no-op.
                      otherEndNodeOf(canvas, gestureState.elementId, gestureState.endpoint)
                }
                hoveredNodeId={livePoint === null ? undefined : hitTest(selectableBoxes, livePoint)}
                canvas={canvas}
                boxes={boxes}
                selectableBoxes={selectableBoxes}
                createId={createId}
                applyResult={applyResult}
              />
            )}
            {edgeLabelEditId !== null && (
              <EdgeLabelEditorOverlay
                editId={edgeLabelEditId}
                canvas={canvas}
                fontFamily={editingFontFamily}
                edgePaths={edgePaths}
                zoom={viewport.zoom}
                palette={palette}
                applyResult={applyResult}
                onClose={() => setEdgeLabelEditId(null)}
              />
            )}
            {groupLabelEditId !== null && (
              <GroupLabelEditorOverlay
                editId={groupLabelEditId}
                canvas={canvas}
                fontFamily={editingFontFamily}
                zoom={viewport.zoom}
                palette={palette}
                applyResult={applyResult}
                onClose={() => setGroupLabelEditId(null)}
              />
            )}
            {commentCompose !== null && (
              <CommentComposeOverlay
                compose={commentCompose}
                canvas={canvas}
                edgePathOf={edgePathOf}
                obstacles={commentPlacementObstacles()}
                createId={createId}
                zoom={viewport.zoom}
                palette={palette}
                applyResult={applyResult}
                onClose={() => setCommentCompose(null)}
              />
            )}
            {gestureState.kind === 'editing-text' &&
              selectedNode !== undefined &&
              nodeKind(selectedNode) === 'text' &&
              selection !== undefined && (
                <MarkdownBodyEditorOverlay
                  node={selectedNode}
                  fontFamily={editingFontFamily}
                  selectionBox={selection.box}
                  sceneNodes={scene.nodes}
                  sceneCurrent={sceneCurrent}
                  threads={threads}
                  onRequestComment={(anchor) => {
                    setCommentCompose({
                      point: { x: selectedNode.x + selectedNode.width, y: selectedNode.y },
                      targetNodeId: selectedNode.id,
                      threadAnchor: { ...anchor, nodeId: selectedNode.id },
                    })
                    return true
                  }}
                  zoom={viewport.zoom}
                  theme={theme}
                  palette={palette}
                  canvas={canvas}
                  gestureState={gestureState}
                  applyResult={applyResult}
                />
              )}
          </div>
        </div>
        {facetPanelOpen &&
          (() => {
            // The panel is ABOUT whatever is selected. An edge selection wins
            // over a node one because selecting an edge clears the node
            // selection, so the two are never both live.
            const edgeTarget =
              selectedEdgeId === null
                ? undefined
                : canvas.edges.find((entry) => entry.id === selectedEdgeId)
            const target = canvas.nodes.find((entry) => entry.id === selectedId)
            // Nothing selected: there is nothing for the inspector to be
            // about. It closes rather than standing there saying so — the
            // same thing a press on blank canvas does to the context menu,
            // which is the semantic this matches. The flag is cleared during
            // render just above, so re-opening it later is an ordinary open
            // rather than a stuck true.
            if (edgeTarget === undefined && target === undefined) return null
            return (
              <FacetFormPanel
                subject={
                  edgeTarget !== undefined
                    ? { kind: 'edge', edge: edgeTarget }
                    : { kind: 'node', node: target as SpatialNode }
                }
                registry={bundledFacetRegistry}
                // What the board already wrote into free-entry fields, so a
                // second classification is a pick. Recomputed per render
                // while the panel is open: one pass over the nodes' facets.
                suggestions={collectFieldSuggestions(canvas.nodes, bundledFacetRegistry)}
                tagSuggestions={[...collectCanvasTags(canvas), ...(tagSuggestions ?? [])]}
                {...(tagLibrary === undefined ? {} : { tagLibrary })}
                variant={inspectorIsSheet ? 'sheet' : 'dock'}
                onTagsChange={(after) => {
                  // Every write is the CHANGE the row showed being made,
                  // applied to the object's tags as the eager chain holds
                  // them (`canvasRef.current`), never the shown list copied
                  // over: under a slow parent the row still shows the list
                  // before the previous commit landed, and on a selection
                  // of five the four other boxes carry tags of their own.
                  if (edgeTarget !== undefined) {
                    const current = canvasRef.current.edges.find((e) => e.id === edgeTarget.id)
                    applyResult({
                      state: { kind: 'idle' },
                      commands: [
                        {
                          kind: 'set-edge-tags' as const,
                          id: edgeTarget.id,
                          tags: retag(current?.tags, edgeTarget.tags ?? [], after),
                        },
                      ],
                    })
                    return
                  }
                  const before = target?.tags ?? []
                  const members = new Set(selectedId !== null ? [selectedId, ...extraIds] : [])
                  const ids =
                    target !== undefined && members.has(target.id)
                      ? [...members]
                      : target === undefined
                        ? []
                        : [target.id]
                  applyResult({
                    state: { kind: 'idle' },
                    commands: ids.flatMap((id) => {
                      const node = canvasRef.current.nodes.find((entry) => entry.id === id)
                      return node === undefined
                        ? []
                        : [
                            {
                              kind: 'set-node-tags' as const,
                              id,
                              tags: retag(node.tags, before, after),
                            },
                          ]
                    }),
                  })
                }}
                onWrite={(key, payload) => {
                  if (edgeTarget !== undefined) {
                    // One edge, because an edge selection is one edge —
                    // there is no multi-edge selection to fan out over.
                    applyResult({
                      state: { kind: 'idle' },
                      commands: [
                        { kind: 'set-edge-facet' as const, id: edgeTarget.id, key, payload },
                      ],
                    })
                    return
                  }
                  // Applies to the whole selection, the semantics the menu
                  // bands had: reshaping five selected nodes must not become
                  // five visits to this panel.
                  const members = new Set(selectedId !== null ? [selectedId, ...extraIds] : [])
                  const ids =
                    target !== undefined && members.has(target.id)
                      ? [...members]
                      : target === undefined
                        ? []
                        : [target.id]
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
