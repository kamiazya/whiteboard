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
 * empty canvas space, or the keyboard-reachable "Add note" button — both
 * open the new node for typing immediately), delete the current
 * selection (Delete/Backspace, disabled while its text editor is open so
 * Backspace-while-typing edits text instead of deleting the node), select
 * an edge (click its line) and delete it (Delete/Backspace), and edit an
 * edge's label (double-click its line; commits on blur, empty removes,
 * Escape cancels), and restyle an edge from its context menu (arrowhead
 * direction per JSON Canvas fromEnd/toEnd, and per-endpoint side pinning
 * with an auto option), create a link node (the palette's "Add link" URL
 * dialog), follow it (double-click, or "Open link" in its context menu —
 * opens in a new tab with noopener), rewrite its URL ("Edit URL"), create
 * a group frame (the palette's "Add group" empty frame, or "Group
 * selection" from a multi-selected node's context menu), move a frame
 * with its geometrically contained members, edit the frame's label
 * (double-click, or "Edit label" in its context menu; empty removes),
 * and — when the host supplies the seams — create a file node referencing
 * another canvas (the palette's "Add canvas" picker), follow it
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
  CanvasColor,
  ClipboardFragment,
  EdgeRoutingStyle,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-canvas-model'
import type { MeasureText, SpatialPresetKey } from '@kamiazya/whiteboard-canvas-render'
import {
  BODY_FONT_SIZE_PX,
  flattenRoundedEdgePath,
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  SPATIAL_THEME_FONT_FAMILY,
  SPATIAL_THEME_GEOMETRY,
} from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  BringToFront,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy as CopyIcon,
  ExternalLink,
  FileBox,
  Focus,
  Frame,
  Image as ImageIcon,
  Link,
  Lock as LockIcon,
  LockOpen,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Pencil,
  Scissors,
  SendToBack,
  SquareDashed,
  StickyNote,
  Tag,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { DOCK_WIDE_BUTTON_CLASS } from '@/components/ui/dock-button'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import {
  extractClipboardFragment,
  parseClipboardText,
  remintClipboardFragment,
} from '../../lib/clipboard-fragment.js'
import {
  hasClipboardFragment,
  readClipboardFragment,
  writeClipboardFragment,
} from '../../lib/clipboard-store.js'
import type { AlignableBox, BoxMove } from './align.js'
import { alignBoxes, distributeBoxes } from './align.js'
import { CanvasPickerDialog, type FileRefOption } from './CanvasPickerDialog.js'
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js'
import type { EditorCommand } from './commands.js'
import { applyCommand } from './commands.js'
import { DragPreviewLayer } from './DragPreviewLayer.js'
import { computeDragPreview, isInFlightGesture } from './drag-preview.js'
import { createEditorAppearance, editorTextFill } from './editor-appearance.js'
import { isFollowableUrl } from './followable-url.js'
import type { Box, ResizeHandleKind } from './geometry.js'
import {
  distanceToPolyline,
  findFreeSpot,
  HANDLE_SIGN,
  hitTest,
  indexNodeBoxes,
  polylineMidpoint,
  resizeBoxByDelta,
  scaleBoxWithin,
  unionBox,
} from './geometry.js'
import type { GestureState } from './gestures.js'
import { createIdleState, NEW_NODE_HEIGHT, NEW_NODE_WIDTH, reduceGesture } from './gestures.js'
import { LinkEmbedLayer } from './LinkEmbedLayer.js'
import { LinkUrlDialog } from './LinkUrlDialog.js'
import { MinimapOverlay } from './MinimapOverlay.js'
import { SelectionOverlay } from './SelectionOverlay.js'
import { renderCanvasToSvg, requiredTextNodeHeight } from './scene-render.js'
import { findShortcut, isTextEntryEvent, type ShortcutId } from './shortcuts.js'
import { type SnapBox, snapBox, snapEdge } from './snap.js'
import { TextNodeEditor } from './TextNodeEditor.js'
import { type EditorTool, TOOL_BUTTON_CLASS, ToolPalette } from './ToolPalette.js'
import { computePinchUpdate } from './touch-pinch.js'
import {
  canvasToScreen,
  clampZoom,
  fitViewportToBoxes,
  IDENTITY_VIEWPORT,
  type Point,
  panBy,
  screenToCanvas,
  type Viewport,
  viewportTransformCss,
  zoomAt,
} from './viewport.js'

/**
 * Machine-checkable out-of-scope list this slice deliberately does not
 * implement — referenced above and asserted by `doc-contract.test.ts`.
 */
export const SPATIAL_EDITOR_UNSUPPORTED = ['persistence', 'sync'] as const

/**
 * Attraction radius in SCREEN pixels, converted to canvas units per gesture
 * so the pull feels the same at every zoom — a fixed canvas threshold would
 * be imperceptible zoomed out and violent zoomed in.
 */
const SNAP_THRESHOLD_SCREEN_PX = 6
/**
 * Grid pitch in canvas units. Deliberately wider than
 * `2 * SNAP_THRESHOLD_SCREEN_PX`: a pitch at or below that makes every
 * lattice line reachable from everywhere, which is silent rounding rather
 * than snapping, and it would out-pull the neighbour edges the user aimed
 * at. At 20 the grid attracts near a line and leaves the rest of the plane
 * alone.
 */
const SNAP_GRID_CANVAS_PX = 20

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
const MINIMAP_MIN_ROOT_WIDTH_PX = 768

/** The routing styles offered in the UI. */
const EDGE_ROUTING_CHOICES: readonly {
  readonly style: EdgeRoutingStyle
  readonly label: string
}[] = [
  { style: 'straight', label: 'Straight' },
  { style: 'orthogonal', label: 'Orthogonal' },
  { style: 'curved', label: 'Curved' },
]

export interface SpatialEditorProps {
  readonly canvas: SpatialCanvas
  readonly onChange: (next: SpatialCanvas, command: EditorCommand) => void
  /**
   * Bumps only on an externally-originated canvas replacement (undo, redo,
   * remote import, hydrate) — never on this component's own `onChange`.
   * Omitted (the default) means every `canvas` prop change is treated as
   * local, matching this component's pre-existing continue-if-valid
   * behavior. A controlling hook that distinguishes origins (see
   * `useCanvasSync`'s `externalVersion`) should always pass it, since an
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
   * The tool active on mount. Defaults to 'hand' — the product opens in
   * navigation mode (user decision 2026-08-08): a plain drag pans and no
   * press can select, move, or edit until the user switches to Select.
   * Tests exercising editing flows pass 'select' explicitly.
   */
  readonly defaultTool?: EditorTool
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
   * Canvas references the picker offers for file nodes. The reference is an
   * OPAQUE string owned by the composition root (browser-local canvas id,
   * daemon alias path). Absent → the "Add canvas" affordance hides.
   */
  readonly fileRefOptions?: readonly FileRefOption[]
  /** Follows a file node's reference (navigation). Absent → follow hides. */
  readonly onOpenFileRef?: (file: string, subpath?: string) => void
  /**
   * Host controls (undo/redo/version history) docked as the palette's
   * leading group — the palette is the single bottom-chrome container.
   */
  readonly paletteLeading?: ReactNode
  /**
   * Referenced canvas CONTENT for inline embeds (embed spec J5a-2). Must
   * be synchronous — hosts pre-fetch and cache; an unresolved reference
   * returns undefined and the card renders. Absent → embeds never expand.
   */
  readonly resolveFileCanvas?: (file: string) => SpatialCanvas | undefined
  /** Image content for media file nodes (data:/blob: href). Sync, cached by the host. */
  readonly resolveFileImage?: (
    file: string,
  ) => { readonly href: string; readonly alt?: string } | undefined
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

/** Imperative surface for a page that needs to drive the viewport from
 * outside (e.g. a daemon's `viewport_request`) without owning viewport as
 * its own state. */
export interface SpatialEditorHandle {
  setViewport(viewport: Viewport): void
  /** Fits the viewport to the given node ids, or to every node when omitted. */
  fitToContent(nodeIds?: readonly string[]): void
}

const EDGE_LABEL_EDITOR_WIDTH_PX = 160
const EDGE_LABEL_EDITOR_HEIGHT_PX = 28

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
const DEFAULT_TEST_ID = 'spatial-editor'
/**
 * Window for OUR double-press detection (see handlePointerDown). Matches the
 * common OS double-click interval; not user-configurable today.
 */
const DOUBLE_PRESS_WINDOW_MS = 400

/** One click of the hand-mode zoom buttons scales by this factor. */
const ZOOM_STEP_FACTOR = 1.25

/** Duplicated copies land offset by this much, cascading on repeat. */
const DUPLICATE_OFFSET_PX = 16

/** Breathing room kept around framed content (zoom to fit / selection). */
const FRAME_MARGIN_PX = 24
const ZOOM_WHEEL_FACTOR = 1.1
/** Canvas-space px per arrow-key nudge on a focused resize handle; Shift multiplies by 4. */
const RESIZE_KEYBOARD_STEP = 8
const RESIZE_KEYBOARD_STEP_LARGE = 32
const ARROW_KEY_DELTA: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
}

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
      lockedNodeIds,
      lockedEdgeIds,
      onToggleEdgeLock,
      onToggleNodeLock,
      fileRefOptions,
      onOpenFileRef,
      paletteLeading,
      resolveFileCanvas,
      resolveFileImage,
      onAddImage,
      isImageFileRef,
    },
    forwardedRef,
  ) {
    const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])
    const rootRef = useRef<HTMLDivElement | null>(null)

    const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT)
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [gestureState, setGestureState] = useState<GestureState>(createIdleState())
    /**
     * Live pointer position during an in-flight move/resize/connect, in canvas
     * space. Component-local on purpose: the reducer still recomputes the real
     * commit from startPoint at pointerup, so this drives ONLY the preview
     * overlay below and never becomes a source of truth. Keeping it out of
     * `canvas` is what stops a per-frame `renderCanvasToSvg` (measured at
     * ~30ms on an 80-node canvas — far past a frame budget).
     */
    const [livePoint, setLivePoint] = useState<Point | null>(null)
    /**
     * Canvas-space lines justifying the current snap, cleared with the
     * gesture. Same rationale as `livePoint`: a per-frame value that drives
     * only an overlay, never the document.
     */
    const [snapGuides, setSnapGuides] = useState<{
      readonly x: readonly number[]
      readonly y: readonly number[]
    } | null>(null)
    // OOUI interaction mode (S6/S7): Hand (navigation) is the default —
    // Select restores the pre-tool editing behavior byte-for-byte; Connect
    // arms object-first click-A, click-B edge creation. Creation is
    // deliberately NOT a mode — the palette's Add note works in every mode.
    const [tool, setTool] = useState<EditorTool>(defaultTool)
    /** Open right-click menu: screen position (root-relative) + hit target. */
    const [contextMenu, setContextMenu] = useState<{
      x: number
      y: number
      nodeId: string | undefined
      edgeId: string | undefined
      point: Point
    } | null>(null)
    /**
     * Additional selected node ids beyond the reducer's single primary
     * selection. Multi-select lives at the component layer on purpose: the
     * gesture reducer keeps its single-node contract, and group operations
     * expand into per-member commands at commit time (see the pointerup and
     * delete paths). Cleared whenever the primary selection clears.
     */
    const [extraIds, setExtraIds] = useState<ReadonlySet<string>>(new Set())
    /**
     * Armed by a second same-target press inside the double-press window;
     * RESOLVED at pointerup: zero movement opens the editor (node) or
     * creates (empty), any movement means it was a drag all along. Firing
     * at the release also sidesteps mousedown's default focus action, which
     * used to blur the just-mounted textarea when we opened at the press.
     */
    const doublePressRef = useRef<{ key: string; point: Point } | null>(null)
    /** In-flight marquee selection rect, in canvas space (Excalidraw
     * semantics: plain drag on empty space selects; pan is Space+drag,
     * middle-button drag, or wheel). */
    const [marquee, setMarquee] = useState<{ start: Point; current: Point } | null>(null)
    const spaceDownRef = useRef(false)
    const isPanningRef = useRef(false)
    // Two-finger touch navigation (`touch-action: none` disables the
    // browser's own scrolling/zooming, so the editor must supply it):
    // root-local positions per active touch pointer, and whether a pinch
    // owns the touch sequence. The flag stays up until EVERY finger lifts,
    // so the lone finger left behind after a pinch cannot fall through to
    // the marquee/move path mid-air.
    const touchPointsRef = useRef<Map<number, Point>>(new Map())
    const pinchActiveRef = useRef(false)
    /**
     * Touch multi-selection, the iOS "hold one, tap the rest" gesture.
     *
     * `gatherAnchorRef` is the finger holding the selection open; while it is
     * down, a second finger's tap on a node collects that node instead of
     * starting a pinch. Long press is NOT the trigger: the browser already
     * synthesises `contextmenu` from it, and taking it would leave touch with
     * no route to an object's menu.
     *
     * A second finger otherwise means pinch, so the two are separated by
     * STATE rather than by timing — gathering needs a finger already holding
     * a node, which a pinch never has. Fingers listed in `gatherPointersRef`
     * have already done their job on the press and stay inert until they lift.
     */
    const gatherAnchorRef = useRef<number | null>(null)
    const gatherPointersRef = useRef<Set<number>>(new Set())
    /** Last primary press for double-press detection: logical target + time. */
    const lastPressRef = useRef<{ key: string; at: number } | null>(null)
    const lastPanPointRef = useRef({ x: 0, y: 0 })
    /**
     * The pointerId this component currently holds capture for, or `null`.
     * Tracked so unmount can best-effort release capture (see the teardown
     * effect below) even though no window-level fallback listener exists to
     * do it otherwise — mirrors `trySetPointerCapture`'s own
     * best-effort/never-throw reasoning.
     */
    const activePointerIdRef = useRef<number | null>(null)

    const canvasRef = useRef(canvas)
    const prevCanvasRef = useRef(canvas)
    const prevExternalVersionRef = useRef(externalVersion)
    canvasRef.current = canvas

    // Controlled-prop-swap policy: a sync-driven parent can replace `canvas`
    // mid-gesture. Feed the reducer a `canvas-replaced` event so it can abort
    // or continue per gestures.ts's documented contract. `origin` is
    // 'external' only when the caller's `externalVersion` counter itself
    // advanced — that is what tells an undo/redo/remote-import replacement
    // (which must cancel the gesture unconditionally) apart from this
    // component's own controlled re-render after `onChange`.
    // Layout, not passive: this must land before the browser can dispatch the
    // next pointer event, or a pointerup could still be reduced against the
    // gesture the replacement was meant to cancel — committing a delta derived
    // from a canvas that no longer exists. Nothing here reads layout, so the
    // synchronous slot costs nothing and removes the need to reason about when
    // React flushes passive effects relative to input.
    useLayoutEffect(() => {
      if (prevCanvasRef.current === canvas) return
      prevCanvasRef.current = canvas
      const isExternal =
        externalVersion !== undefined && externalVersion !== prevExternalVersionRef.current
      prevExternalVersionRef.current = externalVersion
      const result = reduceGesture(gestureState, canvas, {
        type: 'canvas-replaced',
        canvas,
        origin: isExternal ? 'external' : 'local',
      })
      setGestureState(result.state)
      // Mirror gestures.ts's canvas-replaced abort/continue answer into the
      // preview: an abort (result.state no longer in-flight) must retire the
      // preview too, or it would keep drawing a gesture the reducer already
      // cancelled. Uses the SAME predicate applyResult's own clearing check
      // below does, so there is exactly one definition of "no longer in
      // flight" rather than two clearing rules that could drift apart.
      if (!isInFlightGesture(result.state)) {
        setLivePoint(null)
        // The guides justify an in-flight snap; outliving the gesture would
        // leave stray lines on the canvas.
        setSnapGuides(null)
      }
      // gestureState intentionally omitted: this effect only reacts to a new
      // canvas identity, not every gestureState transition (that would create
      // an infinite render loop feeding the reducer's own output back in).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvas, externalVersion])

    /**
     * The LOD gate (embed spec v2, user decision 2026-08-08): a file node
     * expands into an inline miniature only while its ON-SCREEN box is
     * large enough to be legible. Hysteresis (expand at >=200x140, collapse
     * below 160x110 CSS px) keeps pinch-zoom from flickering at the
     * boundary, and a budget caps simultaneous miniatures at the largest
     * candidates (deterministic tie-break by node id). The set is state so
     * layout re-runs only when membership actually changes — never per
     * zoom frame.
     */
    const EXPAND_MIN_W = 200
    const EXPAND_MIN_H = 140
    const COLLAPSE_MIN_W = 160
    const COLLAPSE_MIN_H = 110
    const EMBED_BUDGET = 8
    const [expandedFileIds, setExpandedFileIds] = useState<ReadonlySet<string>>(new Set())
    useEffect(() => {
      if (resolveFileCanvas === undefined) return
      const zoom = viewport.zoom
      const candidates = canvas.nodes
        .filter((node): node is Extract<SpatialNode, { type: 'file' }> => node.type === 'file')
        .filter((node) => {
          const w = node.width * zoom
          const h = node.height * zoom
          return expandedFileIds.has(node.id)
            ? w >= COLLAPSE_MIN_W && h >= COLLAPSE_MIN_H
            : w >= EXPAND_MIN_W && h >= EXPAND_MIN_H
        })
        .sort((a, b) => b.width * b.height - a.width * a.height || a.id.localeCompare(b.id))
        .slice(0, EMBED_BUDGET)
      const next = new Set(candidates.map((node) => node.id))
      const unchanged =
        next.size === expandedFileIds.size && [...next].every((id) => expandedFileIds.has(id))
      if (!unchanged) setExpandedFileIds(next)
    }, [canvas, viewport.zoom, resolveFileCanvas, expandedFileIds])
    const expandFileNode = useMemo(
      () =>
        resolveFileCanvas === undefined
          ? undefined
          : (node: Extract<SpatialNode, { type: 'file' }>) => expandedFileIds.has(node.id),
      [resolveFileCanvas, expandedFileIds],
    )

    // Opaque file references (browser-local canvas ids) become readable
    // card labels through the host-supplied options list.
    const resolveFileLabel = useMemo(() => {
      if (fileRefOptions === undefined) return undefined
      const byFile = new Map(fileRefOptions.map((option) => [option.file, option.label]))
      return (file: string) => byFile.get(file)
    }, [fileRefOptions])
    const { svg, bounds, scene } = useMemo(
      () =>
        renderCanvasToSvg(canvas, {
          measure: resolvedMeasure,
          theme,
          resolveFileLabel,
          resolveFileCanvas,
          expandFileNode,
          resolveFileImage,
        }),
      [
        canvas,
        resolvedMeasure,
        theme,
        resolveFileLabel,
        resolveFileCanvas,
        expandFileNode,
        resolveFileImage,
      ],
    )
    // Routed edge paths in canvas coordinates, for edge hit-testing and the
    // selection highlight. Edges have no area, so selection is a
    // distance-to-polyline test against a zoom-adjusted tolerance. A rounded
    // edge is DRAWN as midpoint-quadratic corners, so its hit/highlight path
    // is the flattened curve — the raw waypoints run through corners the ink
    // never touches.
    const edgePaths = useMemo(
      () =>
        scene.nodes.flatMap((node) =>
          node.kind === 'edge'
            ? [
                {
                  id: node.id,
                  path: node.rounded === true ? flattenRoundedEdgePath(node.path) : node.path,
                },
              ]
            : [],
        ),
      [scene],
    )
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
    const [edgeLabelEditId, setEdgeLabelEditId] = useState<string | null>(null)
    // The URL dialog serves both palette-create and context-menu-edit; which
    // one decides what its submit does.
    const [groupLabelEditId, setGroupLabelEditId] = useState<string | null>(null)
    // `point` (canvas space) is present when creation came from the
    // empty-space context menu: the user already chose WHERE, so the node
    // lands there instead of the viewport-center free spot.
    const [linkDialog, setLinkDialog] = useState<
      | { readonly mode: 'create'; readonly point?: Point }
      | { readonly mode: 'edit'; readonly nodeId: string }
      | null
    >(null)
    const [canvasPicker, setCanvasPicker] = useState<
      | { readonly mode: 'create'; readonly point?: Point }
      | { readonly mode: 'retarget'; readonly nodeId: string }
      | null
    >(null)
    const boxes = useMemo(() => indexNodeBoxes(canvas), [canvas])
    /**
     * Lock only binds when the host wired the seam — an editor mounted
     * without `onToggleNodeLock` has no way to unlock, so blocking there
     * would strand the node.
     */
    const lockEnabled = onToggleNodeLock !== undefined
    const isLocked = (nodeId: string): boolean =>
      lockEnabled && lockedNodeIds !== undefined && lockedNodeIds.has(nodeId)
    /** Boxes a pointer or marquee may target: locked nodes are invisible to both. */
    const selectableBoxes = useMemo(
      () => (lockEnabled ? boxes.filter((entry) => !isLocked(entry.id)) : boxes),
      // isLocked closes over lockedNodeIds/lockEnabled, both listed here.
      [boxes, lockEnabled, lockedNodeIds],
    )
    /** Same seam rule as the node lock: no callback, no enforcement. */
    const edgeLockEnabled = onToggleEdgeLock !== undefined
    const isEdgeLocked = (edgeId: string): boolean =>
      edgeLockEnabled && lockedEdgeIds !== undefined && lockedEdgeIds.has(edgeId)

    /**
     * A lock can arrive from a peer or an agent while the node is ALREADY
     * selected or mid-drag — a case hit-test filtering cannot reach, because
     * the selection exists before the lock does. Dropping it here closes
     * every command path that reads the selection (nudge, delete, resize,
     * z-order, colour, cut) at one point instead of guarding each in turn.
     * A locked primary promotes the first surviving extra rather than
     * clearing the whole selection, so locking one node of many is not a
     * silent deselect-all.
     */
    useEffect(() => {
      if (edgeLockEnabled && selectedEdgeId !== null && isEdgeLocked(selectedEdgeId)) {
        setSelectedEdgeId(null)
        setEdgeLabelEditId((current) => (current === selectedEdgeId ? null : current))
      }
      // isEdgeLocked closes over lockedEdgeIds/edgeLockEnabled, both listed.
    }, [edgeLockEnabled, lockedEdgeIds, selectedEdgeId])

    useEffect(() => {
      if (!lockEnabled) return
      if (gestureState.kind === 'moving' || gestureState.kind === 'resizing') {
        if (isLocked(gestureState.nodeId)) setGestureState(createIdleState())
      }
      const survivingExtras = [...extraIds].filter((id) => !isLocked(id))
      const primaryLocked = selectedId !== null && isLocked(selectedId)
      if (!primaryLocked) {
        if (survivingExtras.length !== extraIds.size) setExtraIds(new Set(survivingExtras))
        return
      }
      const [promoted, ...rest] = survivingExtras
      setSelectedId(promoted ?? null)
      setExtraIds(new Set(rest))
      // isLocked closes over lockedNodeIds/lockEnabled, both listed here.
    }, [lockEnabled, lockedNodeIds, selectedId, extraIds, gestureState])

    /**
     * The dragged node's own content, rendered ONCE per drag (the reducer's
     * pointermove passthrough returns the same state reference, so this memo
     * holds for the whole gesture; a single-node render costs ~0.4ms).
     * Per-frame motion is then a pure CSS transform in DragPreviewLayer —
     * the full-canvas render stays untouched during the drag.
     */
    const dragContentSvg = useMemo(() => {
      if (gestureState.kind !== 'moving') return undefined
      const node = canvas.nodes.find((n) => n.id === gestureState.nodeId)
      if (node === undefined) return undefined
      const rendered = renderCanvasToSvg(
        { nodes: [node], edges: [] },
        { measure: resolvedMeasure, theme, resolveFileLabel, resolveFileImage },
      )
      return {
        svg: rendered.svg,
        originX: gestureState.startX - rendered.bounds.x,
        originY: gestureState.startY - rendered.bounds.y,
      }
    }, [gestureState, canvas, resolvedMeasure, theme, resolveFileLabel, resolveFileImage])

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

    const selectedBox = useMemo(
      () => (selectedId === null ? undefined : boxes.find((b) => b.id === selectedId)?.box),
      [boxes, selectedId],
    )
    const selectedNode = useMemo(
      () => (selectedId === null ? undefined : canvas.nodes.find((n) => n.id === selectedId)),
      [canvas, selectedId],
    )
    /** Narrowed pair so the overlay never has to assert a non-null `selectedId`. */
    const selection =
      selectedId !== null && selectedBox !== undefined
        ? { id: selectedId, box: selectedBox }
        : undefined

    /**
     * Every selected node with the box it currently occupies, primary first.
     *
     * The resize handles surround the UNION of these rather than the primary
     * alone: handles drawn around a group have to act on the group, or a
     * three-node selection offers one node's handles and resizes that node
     * while the other two watch.
     */
    const selectionMembers = useMemo(() => {
      if (selectedId === null) return []
      return [selectedId, ...extraIds].flatMap((id) => {
        const entry = boxes.find((candidate) => candidate.id === id)
        return entry === undefined ? [] : [{ id, box: entry.box }]
      })
    }, [selectedId, extraIds, boxes])
    const selectionBox = useMemo(
      () => unionBox(selectionMembers.map((member) => member.box)),
      [selectionMembers],
    )
    const isMultiSelection = selectionMembers.length > 1

    /**
     * The in-flight preview geometry, derived per frame from the gesture's own
     * start snapshot plus the live pointer — never from `canvas`. See
     * drag-preview.ts for why that matters and for the single-source
     * `resizeBoxByDelta` guarantee it documents.
     */
    const dragPreview = useMemo(
      () => computeDragPreview(gestureState, boxes, livePoint),
      [gestureState, livePoint, boxes],
    )

    /**
     * How far a snap guide extends, in canvas space: across all content plus
     * a margin. Spanning the content rather than the window keeps the line a
     * function of the document alone, so it renders identically at any zoom
     * or scroll position and needs no measured element size.
     */
    const guideSpan = useMemo(() => {
      const GUIDE_MARGIN_PX = 40
      if (boxes.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
      const xs = boxes.flatMap((entry) => [entry.box.x, entry.box.x + entry.box.width])
      const ys = boxes.flatMap((entry) => [entry.box.y, entry.box.y + entry.box.height])
      return {
        minX: Math.min(...xs) - GUIDE_MARGIN_PX,
        maxX: Math.max(...xs) + GUIDE_MARGIN_PX,
        minY: Math.min(...ys) - GUIDE_MARGIN_PX,
        maxY: Math.max(...ys) + GUIDE_MARGIN_PX,
      }
    }, [boxes])

    /**
     * Nudges the POINTER, not the emitted command, so preview and commit see
     * the same value: the reducer derives both from `point`, and adjusting
     * only one of them would let the box render in one place and land in
     * another.
     *
     * Serves both gestures, but they snap DIFFERENT things: a move snaps the
     * box (three lines per axis — edge, centre, edge), a resize snaps only the
     * edge under the handle. Feeding a resize the move candidates would let
     * the box's own centre or far edge pull the handle, which reads as the
     * handle fighting the pointer.
     */
    const snapGesturePoint = (
      raw: Point,
      suspended: boolean,
    ): { point: Point; guides: { x: readonly number[]; y: readonly number[] } } => {
      const unchanged = { point: raw, guides: { x: [], y: [] } }
      if (suspended) return unchanged
      const options = {
        thresholdCanvasPx: SNAP_THRESHOLD_SCREEN_PX / viewport.zoom,
        gridSize: SNAP_GRID_CANVAS_PX,
      }

      if (gestureState.kind === 'resizing') {
        // Only the node being resized is excluded — nothing else moves with a
        // resize, so every other box stays a legitimate target.
        const others = boxes
          .filter((entry) => entry.id !== gestureState.nodeId)
          .map((entry) => entry.box)
        const sign = HANDLE_SIGN[gestureState.handle]
        const start = gestureState.startBox
        const guides: { x: number[]; y: number[] } = { x: [], y: [] }
        let point = raw

        // sign 0 means that axis is anchored (an edge handle moves one axis
        // only), -1 the leading edge travels, +1 the trailing one.
        if (sign.x !== 0) {
          const dx = raw.x - gestureState.startPoint.x
          const edge = sign.x === -1 ? start.x + dx : start.x + start.width + dx
          const snapped = snapEdge(edge, others, options, 'x')
          point = { ...point, x: raw.x + (snapped.position - edge) }
          if (snapped.guide !== undefined) guides.x.push(snapped.guide)
        }
        if (sign.y !== 0) {
          const dy = raw.y - gestureState.startPoint.y
          const edge = sign.y === -1 ? start.y + dy : start.y + start.height + dy
          const snapped = snapEdge(edge, others, options, 'y')
          point = { ...point, y: raw.y + (snapped.position - edge) }
          if (snapped.guide !== undefined) guides.y.push(snapped.guide)
        }
        return { point, guides }
      }

      if (gestureState.kind !== 'moving') return unchanged
      const moving = boxes.find((entry) => entry.id === gestureState.nodeId)
      if (moving === undefined) return unchanged

      const candidate: SnapBox = {
        x: gestureState.startX + (raw.x - gestureState.startPoint.x),
        y: gestureState.startY + (raw.y - gestureState.startPoint.y),
        width: moving.box.width,
        height: moving.box.height,
      }
      // Everything travelling WITH the drag is excluded: a multi-selection
      // member, or a frame's geometrically contained members (same rule the
      // commit uses). Left in, a carried node would attract its own carrier
      // and peg the gesture at a fixed offset.
      //
      // A LOCKED contained member is the exception, and it has to mirror the
      // commit path exactly: that path refuses to move a locked member with
      // its frame, so the member stays put and remains a legitimate
      // alignment target. Dropping it here would silently discard one.
      const movingNode = canvas.nodes.find((n) => n.id === gestureState.nodeId)
      const carried = new Set<string>([gestureState.nodeId, ...extraIds])
      if (movingNode?.type === 'group') {
        for (const n of canvas.nodes) {
          if (
            !isLocked(n.id) &&
            n.x >= gestureState.startX &&
            n.y >= gestureState.startY &&
            n.x + n.width <= gestureState.startX + movingNode.width &&
            n.y + n.height <= gestureState.startY + movingNode.height
          ) {
            carried.add(n.id)
          }
        }
      }

      const result = snapBox(
        candidate,
        boxes.filter((entry) => !carried.has(entry.id)).map((entry) => entry.box),
        options,
      )
      return {
        point: { x: raw.x + (result.x - candidate.x), y: raw.y + (result.y - candidate.y) },
        guides: { x: result.guidesX, y: result.guidesY },
      }
    }

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
      if (result.selectedId !== undefined) setSelectedId(result.selectedId)
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
     * Shared prologue for the overlay's pointer handlers: take pointer capture
     * on the root and hand it back, or `null` when the root is not mounted.
     * (The overlay itself already stops propagation to the root's hit-test.)
     */
    const beginOverlayGesture = (e: React.PointerEvent): HTMLDivElement | null => {
      const root = rootRef.current
      if (root !== null) capturePointer(root, e.pointerId)
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
      if (primaryId === null) {
        setSelectedId(hitId)
        return
      }
      if (hitId === primaryId) {
        // Deselecting the primary promotes an extra, if any.
        const [next, ...rest] = [...extraIds]
        setSelectedId(next ?? null)
        setExtraIds(new Set(rest))
        return
      }
      setSelectedId(primaryId)
      setExtraIds((prev) => {
        const next = new Set(prev)
        if (next.has(hitId)) next.delete(hitId)
        else next.add(hitId)
        return next
      })
    }

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (isOverlayEvent(e)) return
      const root = rootRef.current
      if (root === null) return
      if (e.pointerType === 'touch') {
        touchPointsRef.current.set(e.pointerId, clientPointToRootLocal(e, root))
        if (pinchActiveRef.current) return
        if (gatherPointersRef.current.size > 0 || gatherAnchorRef.current !== null) {
          // Already gathering: any further finger is another tap, never a
          // pinch participant, so it must not sit in touchPointsRef.
          touchPointsRef.current.delete(e.pointerId)
        }
        if (touchPointsRef.current.size === 2 || gatherAnchorRef.current !== null) {
          const anchorId =
            gatherAnchorRef.current ??
            [...touchPointsRef.current.keys()].find((id) => id !== e.pointerId) ??
            null
          const anchorPrimary =
            gatherAnchorRef.current !== null
              ? selectedId
              : gestureState.kind === 'moving'
                ? gestureState.nodeId
                : null
          const gathered =
            anchorPrimary === null
              ? undefined
              : hitTest(selectableBoxes, screenToCanvas(clientPointToRootLocal(e, root), viewport))
          if (gathered !== undefined && anchorId !== null) {
            touchPointsRef.current.delete(e.pointerId)
            gatherPointersRef.current.add(e.pointerId)
            if (gatherAnchorRef.current === null) {
              gatherAnchorRef.current = anchorId
              // Gathering is a selection act, not a drag. Whatever the anchor
              // had begun to move is abandoned here — carrying a half-applied
              // delta into the new multi-selection would jump every node
              // gathered afterwards by an offset the user never gave it.
              if (gestureState.kind !== 'idle') {
                applyResult(reduceGesture(gestureState, canvas, { type: 'pointercancel' }))
              }
            }
            setMarquee(null)
            isPanningRef.current = false
            lastPressRef.current = null
            doublePressRef.current = null
            toggleSelectionMember(anchorPrimary, gathered)
            return
          }
        }
        if (touchPointsRef.current.size === 2) {
          // The second finger converts whatever the first finger started
          // (marquee, node move, double-press arming) into navigation:
          // cancel it all, then pan/zoom until every finger lifts.
          pinchActiveRef.current = true
          setMarquee(null)
          isPanningRef.current = false
          lastPressRef.current = null
          doublePressRef.current = null
          if (gestureState.kind !== 'idle') {
            applyResult(reduceGesture(gestureState, canvas, { type: 'pointercancel' }))
          }
          // Capture BOTH fingers, not just the one that arrived second: an
          // uncaptured first finger crossing outside the root would stop
          // delivering its move/up events here, leaving a stale entry in
          // touchPointsRef that would misread a later one-finger press as
          // a pinch participant.
          for (const pointerId of touchPointsRef.current.keys()) {
            trySetPointerCapture(root, pointerId)
          }
          activePointerIdRef.current = e.pointerId
          return
        }
      }
      const screenPointForPan = clientPointToRootLocal(e, root)
      // Middle-button (or Space-held) drag pans from ANYWHERE — Excalidraw
      // semantics; a plain left drag on empty space marquee-selects instead.
      // The hand tool makes EVERY plain press a pan (nodes included): it is
      // the one-handed touch navigation mode, where a second finger is not
      // available to promote the gesture.
      if (e.button === 1 || (e.button === 0 && (spaceDownRef.current || tool === 'hand'))) {
        e.preventDefault()
        isPanningRef.current = true
        lastPanPointRef.current = screenPointForPan
        return
      }
      if (e.button !== 0) return
      // Deliberately NO pointer capture here. Capturing on the press
      // retargets the subsequent clicks to the capturing root, so a control
      // the press bubbled from never receives its click. Capture is taken
      // on the first real pointermove instead (see handlePointerMove): a
      // press that turns into a drag still gets capture before it can
      // escape the element. Overlay handle/connect gestures are the
      // exception (beginOverlayGesture) — they want capture immediately.
      const screenPoint = clientPointToRootLocal(e, root)
      const point = screenToCanvas(screenPoint, viewport)
      const hitId = hitTest(selectableBoxes, point)

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
      lastPressRef.current = isDoublePress ? null : { key: pressKey, at: now }
      doublePressRef.current = isDoublePress ? { key: pressKey, point } : null

      if (hitId === undefined) {
        setMarquee({ start: point, current: point })
        setExtraIds(new Set())
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
      // on a member keeps it (that press starts a group move).
      if (hitId !== undefined && hitId !== selectedId && !extraIds.has(hitId)) {
        setExtraIds(new Set())
      } else if (hitId !== undefined && extraIds.has(hitId)) {
        // Grabbing an EXTRA promotes it to primary (the reducer selects the
        // pressed node), so the old primary must swap into the extras — same
        // promotion the context-menu path does. Without it the old primary
        // silently drops out of the selection and stays behind on a group
        // move.
        setExtraIds((prev) => {
          const next = new Set(prev)
          next.delete(hitId)
          if (selectedId !== null && selectedId !== hitId) next.add(selectedId)
          return next
        })
      }
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
      // Hand mode is navigation-ONLY: a touch long-press synthesises a
      // contextmenu, and surfacing the edit menu there made phone panning
      // fall into editing mid-gesture (user report 2026-08-08). Switching
      // to Select is the explicit gate into editing affordances.
      if (tool === 'hand') return
      const root = rootRef.current
      if (root === null) return
      const screenPoint = clientPointToRootLocal(e, root)
      const point = screenToCanvas(screenPoint, viewport)
      // The MENU hit-tests every node, locked included — a locked node has
      // to stay right-clickable or Unlock would be unreachable. Only the
      // selection side effect below is skipped for it.
      const hitId = hitTest(boxes, point)
      // Node and edge selection stay mutually exclusive here too (see the
      // pointerdown path): Delete acts on a selected edge FIRST, so leaving
      // the other object type selected makes Delete remove the wrong thing.
      if (hitId !== undefined && !isLocked(hitId)) {
        // Right-clicking a member of an existing multi-selection must not
        // shrink it: promote the target to primary and keep the old primary
        // in the extras, or "Group selection" silently loses a node.
        if (extraIds.has(hitId)) {
          setExtraIds((prev) => {
            const next = new Set(prev)
            next.delete(hitId)
            if (selectedId !== null && selectedId !== hitId) next.add(selectedId)
            return next
          })
        }
        setSelectedId(hitId)
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
        setSelectedId(null)
        setExtraIds(new Set())
      }
      setContextMenu({
        x: screenPoint.x,
        y: screenPoint.y,
        nodeId: hitId,
        edgeId: hitEdge?.id,
        point,
      })
    }

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const root = rootRef.current
      if (root === null) return
      // A gathering finger has already acted on its press, and the anchor's
      // own gesture was cancelled when gathering began — neither may resume
      // dragging the canvas while the other is still down.
      if (gatherPointersRef.current.has(e.pointerId) || gatherAnchorRef.current === e.pointerId) {
        return
      }
      if (e.pointerType === 'touch' && touchPointsRef.current.has(e.pointerId)) {
        const points = touchPointsRef.current
        const nextPoint = clientPointToRootLocal(e, root)
        if (pinchActiveRef.current && points.size >= 2) {
          // The pinch pair is the two longest-lived fingers (Map preserves
          // insertion order); later fingers are tracked but inert.
          const [idA, idB] = points.keys()
          if (e.pointerId === idA || e.pointerId === idB) {
            const prev = { a: points.get(idA)!, b: points.get(idB)! }
            const next = {
              a: e.pointerId === idA ? nextPoint : prev.a,
              b: e.pointerId === idB ? nextPoint : prev.b,
            }
            const { panDelta, zoomFactor, anchor } = computePinchUpdate(prev, next)
            setViewport((vp) => zoomAt(panBy(vp, panDelta), anchor, zoomFactor))
          }
          points.set(e.pointerId, nextPoint)
          return
        }
        points.set(e.pointerId, nextPoint)
        // A lone finger left behind by a pinch stays inert until it lifts.
        if (pinchActiveRef.current) return
      }
      // First movement of an in-flight gesture: take capture now (see the
      // handlePointerDown comment for why not at the press). Idempotent —
      // re-capturing the same pointer is a no-op.
      if (
        activePointerIdRef.current === null &&
        (isPanningRef.current || gestureState.kind !== 'idle')
      ) {
        capturePointer(root, e.pointerId)
      }
      const screenPoint = clientPointToRootLocal(e, root)
      if (marquee !== null) {
        setMarquee({ start: marquee.start, current: screenToCanvas(screenPoint, viewport) })
        return
      }
      if (isPanningRef.current) {
        const screenDelta = {
          x: screenPoint.x - lastPanPointRef.current.x,
          y: screenPoint.y - lastPanPointRef.current.y,
        }
        lastPanPointRef.current = screenPoint
        setViewport((vp) => panBy(vp, screenDelta))
        return
      }
      if (gestureState.kind === 'idle') return
      const snapped = snapGesturePoint(
        screenToCanvas(screenPoint, viewport),
        e.metaKey || e.ctrlKey,
      )
      setSnapGuides(snapped.guides)
      setLivePoint(snapped.point)
      applyResult(
        reduceGesture(gestureState, canvas, { type: 'pointermove', point: snapped.point }),
      )
    }

    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
      const root = rootRef.current
      // Gathering fingers act on the press, so their release carries no
      // meaning — running the click/marquee logic here would re-collapse the
      // very selection the gesture just built. The anchor lifting ends it.
      if (gatherPointersRef.current.delete(e.pointerId)) return
      if (gatherAnchorRef.current === e.pointerId) {
        gatherAnchorRef.current = null
        touchPointsRef.current.delete(e.pointerId)
        return
      }
      if (e.pointerType === 'touch') {
        touchPointsRef.current.delete(e.pointerId)
        if (pinchActiveRef.current) {
          if (touchPointsRef.current.size === 0) pinchActiveRef.current = false
          // Fingers lifting out of a pinch never run the click/marquee
          // release logic — the sequence was navigation, not a gesture.
          return
        }
      }
      activePointerIdRef.current = null
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
        const [primary, ...rest] = hitIds
        setSelectedId(primary ?? null)
        setExtraIds(new Set(rest))
        // A drag that began on an edge line was a marquee, not an edge click
        // — drop the press-time edge selection so Delete acts on the nodes.
        setSelectedEdgeId(null)
        return
      }
      if (isPanningRef.current) {
        isPanningRef.current = false
        return
      }
      if (root === null) return
      const screenPoint = clientPointToRootLocal(e, root)
      // Snapped with the same helper the preview used, so the box commits
      // exactly where the last frame drew it.
      const point = snapGesturePoint(
        screenToCanvas(screenPoint, viewport),
        e.metaKey || e.ctrlKey,
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
          isImageFileRef?.(node.file) !== true
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
        const extras = [...extraIds]
          .filter((id) => id !== moved.id)
          .flatMap((id) => {
            const node = canvasRef.current.nodes.find((n) => n.id === id)
            return node === undefined
              ? []
              : [{ kind: 'move-node' as const, id, x: node.x + dx, y: node.y + dy }]
          })
        // Moving a group frame carries its members along: every node fully
        // contained in the frame's PRE-move box (JSON Canvas containment is
        // geometric — there is no parent pointer) gets the same delta.
        const movedNode = canvasRef.current.nodes.find((n) => n.id === moved.id)
        const alreadyMoving = new Set([moved.id, ...extras.map((c) => c.id)])
        const memberMoves =
          movedNode?.type === 'group'
            ? canvasRef.current.nodes
                .filter(
                  (n) =>
                    !alreadyMoving.has(n.id) &&
                    // Containment is geometric, so a locked member would
                    // otherwise be carried along by its frame — the one way
                    // a lock could be moved without ever being selected.
                    !isLocked(n.id) &&
                    n.x >= gestureState.startX &&
                    n.y >= gestureState.startY &&
                    n.x + n.width <= gestureState.startX + movedNode.width &&
                    n.y + n.height <= gestureState.startY + movedNode.height,
                )
                .map((n) => ({ kind: 'move-node' as const, id: n.id, x: n.x + dx, y: n.y + dy }))
            : []
        if (extras.length > 0 || memberMoves.length > 0) {
          applyResult({ ...result, commands: [...result.commands, ...extras, ...memberMoves] })
          return
        }
      }
      applyResult(result)
    }

    const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
      // Pointer ids are reused, so a gathering finger left in these refs by a
      // cancel would silently deaden whichever later touch inherits its id.
      gatherPointersRef.current.delete(e.pointerId)
      if (gatherAnchorRef.current === e.pointerId) gatherAnchorRef.current = null
      if (e.pointerType === 'touch') {
        touchPointsRef.current.delete(e.pointerId)
        if (touchPointsRef.current.size === 0) pinchActiveRef.current = false
      }
      isPanningRef.current = false
      activePointerIdRef.current = null
      applyResult(reduceGesture(gestureState, canvas, { type: 'pointercancel' }))
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
     * The selected nodes as align/distribute inputs, read from canvasRef so
     * a menu action never computes against a stale render closure. Locked
     * nodes cannot be in a selection (see the pruning effect above), so they
     * are absent here too — neither moved nor counted toward the bounds.
     */
    const selectedAlignableBoxes = (): AlignableBox[] => {
      if (selection === undefined) return []
      const ids = new Set([selection.id, ...extraIds])
      return canvasRef.current.nodes
        .filter((node) => ids.has(node.id))
        .map(({ id, x, y, width, height }) => ({ id, x, y, width, height }))
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
     * Clones the selection as ONE batch command (one undo step): reminted
     * ids via the clipboard-fragment helpers, +16px offset (the standard
     * duplicate-again cascade), edges kept only when both endpoints are
     * selected — with their properties. The copies become the selection.
     */
    const duplicateSelection = (): boolean => {
      if (selection === undefined) return false
      const current = canvasRef.current
      const fragment = extractClipboardFragment(current, new Set([selection.id, ...extraIds]))
      if (fragment.nodes.length === 0) return false
      const existingIds = new Set([
        ...current.nodes.map((node) => node.id),
        ...current.edges.map((edge) => edge.id),
      ])
      const reminted = remintClipboardFragment(
        fragment,
        () => createId?.() ?? crypto.randomUUID(),
        existingIds,
      )
      const command: EditorCommand = {
        kind: 'batch',
        commands: [
          ...reminted.nodes.map(
            (node) =>
              ({
                kind: 'create-node',
                node: {
                  ...node,
                  x: node.x + DUPLICATE_OFFSET_PX,
                  y: node.y + DUPLICATE_OFFSET_PX,
                },
              }) as const,
          ),
          ...reminted.edges.map((edge) => ({ kind: 'create-edge', edge }) as const),
        ],
      }
      const running = applyCommand(current, command)
      if (running === current) return false
      onChange(running, command)
      const [first, ...rest] = reminted.nodes.map((node) => node.id)
      if (first !== undefined) {
        setSelectedId(first)
        setExtraIds(new Set(rest))
        setSelectedEdgeId(null)
      }
      return true
    }

    /**
     * Copy the selection into the in-app clipboard slot, returning the
     * fragment so the caller can also hand it to the OS clipboard. null
     * when there is nothing to copy.
     */
    const copySelection = (): ClipboardFragment | null => {
      if (selection === undefined) return null
      const fragment = extractClipboardFragment(
        canvasRef.current,
        new Set([selection.id, ...extraIds]),
      )
      if (fragment.nodes.length === 0) return null
      writeClipboardFragment(fragment)
      return fragment
    }

    /** Remove the selection as ONE batch (one undo step). */
    const deleteSelectionAsBatch = (): boolean => {
      if (selection === undefined) return false
      const ids = [selection.id, ...extraIds]
      const command: EditorCommand = {
        kind: 'batch',
        commands: ids.map((id) => ({ kind: 'delete-node', id }) as const),
      }
      const running = applyCommand(canvasRef.current, command)
      if (running === canvasRef.current) return false
      onChange(running, command)
      setSelectedId(null)
      setExtraIds(new Set())
      setSelectedEdgeId(null)
      return true
    }

    /** A note carrying pasted foreign text, at the viewport center. */
    const createTextNodeAtViewportCenter = (text: string): void => {
      const point = screenToCanvas(viewportCenterScreen(), viewport)
      const node: SpatialNode = {
        id: createId?.() ?? crypto.randomUUID(),
        type: 'text',
        x: Math.round(point.x - NEW_NODE_WIDTH / 2),
        y: Math.round(point.y - NEW_NODE_HEIGHT / 2),
        width: NEW_NODE_WIDTH,
        height: NEW_NODE_HEIGHT,
        text,
      }
      const command: EditorCommand = { kind: 'create-node', node }
      const running = applyCommand(canvasRef.current, command)
      if (running === canvasRef.current) return
      onChange(running, command)
      setSelectedId(node.id)
      setExtraIds(new Set())
      setSelectedEdgeId(null)
    }

    /**
     * Paste the stored fragment as ONE batch: reminted ids, edges remapped.
     * With an anchor point (the empty-space menu's "Paste here") the
     * fragment's bounding box centers on it; without one (Cmd+V) copies
     * land +16px from their source coordinates, cascading like duplicate.
     */
    const pasteClipboard = (at?: Point): boolean => {
      const fragment = readClipboardFragment()
      if (fragment === null) return false
      return pasteFragment(fragment, at)
    }

    /** Paste an explicit fragment (in-app slot, or one parsed off the OS clipboard). */
    const pasteFragment = (
      fragment: Pick<ClipboardFragment, 'nodes' | 'edges'>,
      at?: Point,
    ): boolean => {
      if (fragment.nodes.length === 0) return false
      const current = canvasRef.current
      const existingIds = new Set([
        ...current.nodes.map((node) => node.id),
        ...current.edges.map((edge) => edge.id),
      ])
      const reminted = remintClipboardFragment(
        fragment,
        () => createId?.() ?? crypto.randomUUID(),
        existingIds,
      )
      let dx = DUPLICATE_OFFSET_PX
      let dy = DUPLICATE_OFFSET_PX
      if (at !== undefined) {
        const minX = Math.min(...reminted.nodes.map((node) => node.x))
        const minY = Math.min(...reminted.nodes.map((node) => node.y))
        const maxX = Math.max(...reminted.nodes.map((node) => node.x + node.width))
        const maxY = Math.max(...reminted.nodes.map((node) => node.y + node.height))
        dx = Math.round(at.x - (minX + maxX) / 2)
        dy = Math.round(at.y - (minY + maxY) / 2)
      }
      const command: EditorCommand = {
        kind: 'batch',
        commands: [
          ...reminted.nodes.map(
            (node) =>
              ({ kind: 'create-node', node: { ...node, x: node.x + dx, y: node.y + dy } }) as const,
          ),
          ...reminted.edges.map((edge) => ({ kind: 'create-edge', edge }) as const),
        ],
      }
      const running = applyCommand(current, command)
      if (running === current) return false
      onChange(running, command)
      const [first, ...rest] = reminted.nodes.map((node) => node.id)
      if (first !== undefined) {
        setSelectedId(first)
        setExtraIds(new Set(rest))
        setSelectedEdgeId(null)
      }
      return true
    }

    /**
     * Select every node; the first becomes primary, the rest extras.
     * Always returns true, INCLUDING on an empty canvas: returning false
     * would let the chord fall through to the browser's own select-all,
     * highlighting the whole page. A handled no-op still consumes it.
     */
    const selectAllNodes = (): boolean => {
      const [first, ...rest] = canvasRef.current.nodes
        .map((node) => node.id)
        .filter((id) => !isLocked(id))
      if (first === undefined) return true
      setSelectedId(first)
      setExtraIds(new Set(rest))
      setSelectedEdgeId(null)
      return true
    }

    /**
     * Toggle the lock on the current selection. Lock is host state, so
     * this reports through the callback and never touches the canvas
     * value — a lock is not an edit to the document.
     */
    const toggleSelectionLock = (): boolean => {
      // An edge selection is exclusive with a node selection, so this is a
      // dispatch, not a merge.
      if (edgeLockEnabled && selectedEdgeId !== null) {
        onToggleEdgeLock?.(selectedEdgeId, !isEdgeLocked(selectedEdgeId))
        return true
      }
      if (!lockEnabled || onToggleNodeLock === undefined || selection === undefined) return false
      const ids = [selection.id, ...extraIds]
      // The primary's current state decides the direction, so a mixed
      // selection lands on ONE state instead of flipping each node.
      const next = !isLocked(selection.id)
      for (const id of ids) onToggleNodeLock(id, next)
      if (next) {
        setSelectedId(null)
        setExtraIds(new Set())
      }
      return true
    }

    /** Table-dispatched shortcut handlers, keyed by the catalog's ids. */
    const runShortcut = (id: ShortcutId): boolean => {
      switch (id) {
        case 'toggle-lock':
          return toggleSelectionLock()
        case 'zoom-to-fit':
          return frameContent()
        case 'zoom-to-selection':
          return frameSelection()
        case 'select-all':
          return selectAllNodes()
        case 'duplicate-selection':
          return duplicateSelection()
        case 'reorder-forward':
          return reorderSelection('forward')
        case 'reorder-backward':
          return reorderSelection('backward')
        case 'reorder-front':
          return reorderSelection('front')
        case 'reorder-back':
          return reorderSelection('back')
        default:
          // Inline-handled ids never reach here (findShortcut skips them).
          return false
      }
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Declarative shortcuts first — see shortcuts.ts, the single catalog.
      const shortcut = findShortcut(e.nativeEvent, tool)
      if (shortcut !== undefined && runShortcut(shortcut.id)) {
        e.preventDefault()
        return
      }
      // Keyboard equivalent of pointercancel: discards an in-flight
      // resize/move/connect gesture without committing it.
      if (e.key === 'Escape' && selectedEdgeId !== null) {
        e.preventDefault()
        setSelectedEdgeId(null)
        return
      }
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        selectedEdgeId !== null &&
        gestureState.kind !== 'editing-text'
      ) {
        const target = e.target as HTMLElement | null
        const tag = target?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !target?.isContentEditable) {
          e.preventDefault()
          applyResult({
            state: { kind: 'idle' },
            commands: [{ kind: 'delete-edge', id: selectedEdgeId } as const],
          })
          setSelectedEdgeId(null)
          return
        }
      }
      if (e.key === 'Escape' && gestureState.kind !== 'idle') {
        e.preventDefault()
        applyResult(reduceGesture(gestureState, canvas, { type: 'pointercancel' }))
        return
      }
      // Delete/Backspace deletes the current selection — but never while the
      // event's own target is a text-entry surface (the open TextNodeEditor's
      // textarea, or any other input this root might contain), or Backspace
      // while typing would delete the node instead of a character. The
      // reducer's own editing-text guard is the second, machine-checkable
      // layer of that same policy (see gestures.ts's delete-selection arm).
      // Arrow keys nudge the SELECTED node (standard canvas-tool parity);
      // Shift multiplies the step. A focused resize handle handles arrows
      // itself and stops propagation there, so an arrow reaching THIS
      // handler is never a resize.
      if (e.key === ' ' && gestureState.kind === 'idle') {
        // Held Space turns the next left-drag into a pan (Excalidraw
        // semantics). preventDefault stops the page scrolling on Space —
        // but never while the key originates in a text-entry surface. Node
        // text editing is covered by the gesture-state check (editing-text
        // is not idle); the edge label editor keeps the gesture idle, so a
        // typed space would otherwise be swallowed here.
        const target = e.target as HTMLElement | null
        const tag = target?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !target?.isContentEditable) {
          e.preventDefault()
          spaceDownRef.current = true
        }
        return
      }
      const nudge = ARROW_KEY_DELTA[e.key]
      if (
        nudge !== undefined &&
        selection !== undefined &&
        selectedNode !== undefined &&
        gestureState.kind === 'idle'
      ) {
        e.preventDefault()
        const step = e.shiftKey ? RESIZE_KEYBOARD_STEP_LARGE : RESIZE_KEYBOARD_STEP
        // Nudge the WHOLE selection, not just the primary: a multi-selection
        // that tore apart under the arrow keys was a latent bug select-all
        // makes trivial to hit. Positions are read from canvasRef, not the
        // render closure — key auto-repeat delivers keydowns faster than
        // commits re-render, and a stale base clobbers the previous nudge.
        const ids = [selectedNode.id, ...extraIds]
        const moves = ids.flatMap((id) => {
          const current = canvasRef.current.nodes.find((n) => n.id === id)
          if (current === undefined) return []
          return [
            {
              kind: 'move-node' as const,
              id: current.id,
              x: current.x + nudge.dx * step,
              y: current.y + nudge.dy * step,
            },
          ]
        })
        if (moves.length === 0) return
        // ONE batch, not N commands: a multi-node nudge is one user action
        // and must undo as one step (N separate commits would only group by
        // the UndoManager's merge-timing heuristic).
        applyResult({ state: gestureState, commands: [{ kind: 'batch', commands: moves }] })
        return
      }
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        selection !== undefined &&
        extraIds.size > 0 &&
        gestureState.kind !== 'editing-text'
      ) {
        e.preventDefault()
        const ids = [selection.id, ...extraIds]
        applyResult({
          state: { kind: 'idle' },
          commands: ids.map((id) => ({ kind: 'delete-node' as const, id })),
          selectedId: null,
        })
        setExtraIds(new Set())
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection !== undefined) {
        const target = e.target as HTMLElement | null
        const tag = target?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
        e.preventDefault()
        applyResult(
          reduceGesture(gestureState, canvas, { type: 'delete-selection', nodeId: selection.id }),
        )
      }
    }

    const handleResizeHandleKeyDown = (
      handle: ResizeHandleKind,
      _handleBox: Box,
      e: React.KeyboardEvent,
    ) => {
      if (selection === undefined) return
      // Geometry comes from `canvasRef`, not from the render snapshot the
      // pointer path can afford to use. Key repeat delivers the next press
      // before React has re-rendered, and a parent that applies `onChange`
      // asynchronously lags further still — reading the stale snapshot would
      // make every press compute the same coordinates, so holding the key
      // would resize once and then appear to stick.
      const members = [selection.id, ...extraIds].flatMap((id) => {
        const node = canvasRef.current.nodes.find((candidate) => candidate.id === id)
        return node === undefined
          ? []
          : [{ id, box: { x: node.x, y: node.y, width: node.width, height: node.height } }]
      })
      // The resize anchor is the box the HANDLES surround, not the handle's
      // own tiny hit-box `_handleBox` describes — same reasoning as
      // onHandlePointerDown's `box: selectionBox` below.
      const box = unionBox(members.map((member) => member.box))
      if (box === undefined) return
      const step = e.shiftKey ? RESIZE_KEYBOARD_STEP_LARGE : RESIZE_KEYBOARD_STEP
      const delta = ARROW_KEY_DELTA[e.key]
      if (delta === undefined) return
      e.preventDefault()
      const nextBox = resizeBoxByDelta(box, handle, delta.dx * step, delta.dy * step)
      if (
        nextBox.x === box.x &&
        nextBox.y === box.y &&
        nextBox.width === box.width &&
        nextBox.height === box.height
      ) {
        return
      }
      // Same handles, same meaning as the pointer drag: a lone node takes the
      // dragged box verbatim, a selection has each member re-placed inside it.
      const commands: readonly EditorCommand[] =
        members.length > 1
          ? members.map((member) => {
              const scaled = scaleBoxWithin(box, nextBox, member.box)
              return {
                kind: 'resize-node',
                id: member.id,
                x: scaled.x,
                y: scaled.y,
                width: scaled.width,
                height: scaled.height,
              }
            })
          : [
              {
                kind: 'resize-node',
                id: selection.id,
                x: nextBox.x,
                y: nextBox.y,
                width: nextBox.width,
                height: nextBox.height,
              },
            ]
      // Threaded through a running canvas, not re-applied to `canvasRef`
      // each time: the ref does not advance within this tick, so a second
      // command built on it would discard the first.
      let running = canvasRef.current
      for (const command of commands) {
        running = applyCommand(running, command)
        onChange(running, command)
      }
      // Same write-back the gesture path does (see applyResult): without it
      // the ref keeps describing the pre-keypress canvas until the parent's
      // re-render lands.
      canvasRef.current = running
    }

    const handleConnectKeyDown = () => {
      if (selection === undefined) return
      applyResult(
        reduceGesture(gestureState, canvas, { type: 'pointerdown-connect', nodeId: selection.id }),
      )
    }

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

    const handleWheelRef = useRef(handleWheel)
    handleWheelRef.current = handleWheel

    useEffect(() => {
      const root = rootRef.current
      if (root === null) return
      const onWheel = (e: WheelEvent) => handleWheelRef.current(e)
      root.addEventListener('wheel', onWheel, { passive: false })
      return () => root.removeEventListener('wheel', onWheel)
    }, [])

    // Unmount-mid-gesture safety net. Every pointer handler above is a JSX
    // prop (the wheel listener is this component's only native one, and it
    // already cleans itself up), so React tears them all down with the
    // component and no stale handler can fire an onChange/command after
    // this point — that half of "no listener leak" is structural, not
    // something this effect needs to do. What React does NOT do for us is
    // release pointer capture the platform is still holding on our behalf;
    // an unmount mid-drag (route change, a parent swapping this component
    // out) would otherwise leave the browser holding capture for a pointer
    // no element can any longer respond to. Best-effort/never-throw, same
    // reasoning as `trySetPointerCapture`.
    useEffect(() => {
      // Capture the root HERE, at mount, rather than reading `rootRef.current`
      // inside the cleanup closure: React detaches the ref (sets it to
      // `null`) before this cleanup runs on unmount, so reading the ref at
      // cleanup time would always see `null` and silently skip the release.
      const root = rootRef.current
      return () => {
        const pointerId = activePointerIdRef.current
        if (root === null || pointerId === null) return
        try {
          root.releasePointerCapture(pointerId)
        } catch {
          // best-effort — see doc comment above
        }
      }
    }, [])

    /** Creates a text node centered on `point` (canvas space) and opens it for typing. */
    const createNodeAt = (point: Point) => {
      applyResult(
        reduceGesture(gestureState, canvas, { type: 'dblclick-empty', point }, { createId }),
      )
    }

    /**
     * The button path (unlike double-click, whose point comes straight from
     * the pointer) always resolves to the same viewport-center point, so
     * without a placement rule every click here would stack an identical,
     * unreachable rect on the last one. `findFreeSpot` cascades off the
     * CURRENT node boxes (read from `canvasRef.current`, not the possibly-
     * stale `canvas` prop) so two rapid clicks still see each other's result.
     */
    /** Root-local screen point at the middle of the visible canvas. */
    const viewportCenterScreen = () => {
      const root = rootRef.current
      return root === null ? { x: 0, y: 0 } : { x: root.clientWidth / 2, y: root.clientHeight / 2 }
    }

    /**
     * The editor's own pixel size, for the minimap's visible-area marker.
     *
     * A ResizeObserver rather than a window `resize` listener, because the
     * container resizes without the window doing so — a side panel opening,
     * the browser chrome changing height on mobile — and a marker that lags
     * those is wrong about where you are.
     *
     * Guarded because jsdom has no ResizeObserver: without the guard every
     * jsdom test that mounts this editor would throw. There it measures once
     * and stays there, which is correct for a layout that never changes.
     */
    const [rootSize, setRootSize] = useState({ width: 0, height: 0 })
    useLayoutEffect(() => {
      const root = rootRef.current
      if (root === null) return
      const measure = () => {
        setRootSize((prev) =>
          prev.width === root.clientWidth && prev.height === root.clientHeight
            ? prev
            : { width: root.clientWidth, height: root.clientHeight },
        )
      }
      measure()
      if (typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(measure)
      observer.observe(root)
      return () => observer.disconnect()
    }, [])

    /**
     * Node boxes for the overview, with each authored colour resolved to the
     * accent the scene already uses for it. A preset key resolves through the
     * current mode's palette; a hex passes through; an unstyled node carries
     * no colour and the overview falls back to its muted default.
     */
    const minimapNodes = useMemo(() => {
      const palette = theme === 'dark' ? SPATIAL_DARK_PALETTE : SPATIAL_LIGHT_PALETTE
      const colorOf = (id: string): string | undefined => {
        const color = canvas.nodes.find((n) => n.id === id)?.color
        if (color === undefined) return undefined
        if (color.startsWith('#')) return color
        return palette.presets[color as SpatialPresetKey]?.stroke
      }
      return boxes.map((entry) => ({ ...entry.box, color: colorOf(entry.id) }))
    }, [boxes, canvas, theme])

    /** Hand-mode zoom controls: zoom about the viewport CENTER, not a pointer. */
    const zoomAtViewportCenter = (factor: number) => {
      setViewport((vp) => zoomAt(vp, viewportCenterScreen(), factor))
    }

    /**
     * Pans so the union of all node boxes sits centered in the viewport,
     * keeping the current zoom (the hand-mode "where did my content go"
     * recovery). No boxes → no-op.
     */
    /** Union of the given nodes' boxes, or undefined when there is none. */
    const contentBounds = (ids?: ReadonlySet<string>) => {
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxX = Number.NEGATIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      for (const { id, box } of boxes) {
        if (ids !== undefined && !ids.has(id)) continue
        if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) continue
        minX = Math.min(minX, box.x)
        minY = Math.min(minY, box.y)
        maxX = Math.max(maxX, box.x + box.width)
        maxY = Math.max(maxY, box.y + box.height)
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined
      return { minX, minY, maxX, maxY }
    }

    /**
     * Frames the given content: pans so its center sits at the viewport
     * center, and zooms so the whole box fits with a small margin —
     * magnifying a small selection as readily as it shrinks an oversized
     * canvas, which is the whole point of zoom-to-selection. Never
     * magnifies past 1:1 (a two-word note would otherwise fill the screen)
     * and stays inside the viewport module's own [MIN_ZOOM, MAX_ZOOM].
     */
    const frameContent = (ids?: ReadonlySet<string>) => {
      const bounds = contentBounds(ids)
      if (bounds === undefined) return false
      const root = rootRef.current
      const center = viewportCenterScreen()
      const contentCenter = {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      }
      const width = Math.max(1, bounds.maxX - bounds.minX)
      const height = Math.max(1, bounds.maxY - bounds.minY)
      setViewport((vp) => {
        let zoom = vp.zoom
        if (root !== null) {
          const usableWidth = Math.max(1, root.clientWidth - FRAME_MARGIN_PX * 2)
          const usableHeight = Math.max(1, root.clientHeight - FRAME_MARGIN_PX * 2)
          zoom = clampZoom(Math.min(1, usableWidth / width, usableHeight / height))
        }
        return {
          zoom,
          x: contentCenter.x - center.x / zoom,
          y: contentCenter.y - center.y / zoom,
        }
      })
      return true
    }

    /** Frames the selection, or everything when nothing is selected. */
    const frameSelection = (): boolean => {
      if (selection === undefined) return frameContent()
      return frameContent(new Set([selection.id, ...extraIds]))
    }

    const createNodeAtViewportCenter = () => {
      const preferred = screenToCanvas(viewportCenterScreen(), viewport)
      const occupied = indexNodeBoxes(canvasRef.current).map((b) => b.box)
      const point = findFreeSpot(
        preferred,
        { width: NEW_NODE_WIDTH, height: NEW_NODE_HEIGHT },
        occupied,
      )
      createNodeAt(point)
      panToShow({
        x: Math.round(point.x - NEW_NODE_WIDTH / 2),
        y: Math.round(point.y - NEW_NODE_HEIGHT / 2),
        width: NEW_NODE_WIDTH,
        height: NEW_NODE_HEIGHT,
      })
    }

    /** Link nodes are label-only chrome — a note-height box would be mostly
     * empty, so they get a shorter default. */
    const LINK_NODE_HEIGHT = 60
    const createLinkAtViewportCenter = (url: string, at?: Point) => {
      const root = rootRef.current
      const centerScreen =
        root === null ? { x: 0, y: 0 } : { x: root.clientWidth / 2, y: root.clientHeight / 2 }
      const preferred = screenToCanvas(centerScreen, viewport)
      const occupied = indexNodeBoxes(canvasRef.current).map((b) => b.box)
      const point =
        at ?? findFreeSpot(preferred, { width: NEW_NODE_WIDTH, height: LINK_NODE_HEIGHT }, occupied)
      const id =
        createId?.() ??
        (typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : String(Math.random()))
      const node: SpatialNode = {
        id,
        type: 'link',
        x: Math.round(point.x - NEW_NODE_WIDTH / 2),
        y: Math.round(point.y - LINK_NODE_HEIGHT / 2),
        width: NEW_NODE_WIDTH,
        height: LINK_NODE_HEIGHT,
        url,
      }
      applyResult({
        state: { kind: 'idle' },
        commands: [{ kind: 'create-node', node }],
        selectedId: id,
      })
      panToShow({ x: node.x, y: node.y, width: node.width, height: node.height })
    }

    /** File nodes are reference cards like links — same shorter default box. */
    const createFileRefAtViewportCenter = (file: string, at?: Point) => {
      const root = rootRef.current
      const centerScreen =
        root === null ? { x: 0, y: 0 } : { x: root.clientWidth / 2, y: root.clientHeight / 2 }
      const preferred = screenToCanvas(centerScreen, viewport)
      const occupied = indexNodeBoxes(canvasRef.current).map((b) => b.box)
      const point =
        at ?? findFreeSpot(preferred, { width: NEW_NODE_WIDTH, height: LINK_NODE_HEIGHT }, occupied)
      const id = newId()
      const node: SpatialNode = {
        id,
        type: 'file',
        x: Math.round(point.x - NEW_NODE_WIDTH / 2),
        y: Math.round(point.y - LINK_NODE_HEIGHT / 2),
        width: NEW_NODE_WIDTH,
        height: LINK_NODE_HEIGHT,
        file,
      }
      applyResult({
        state: { kind: 'idle' },
        commands: [{ kind: 'create-node', node }],
        selectedId: id,
      })
      panToShow({ x: node.x, y: node.y, width: node.width, height: node.height })
    }

    /** Default frame for a created image node; the picture letterboxes into it. */
    const IMAGE_NODE_WIDTH = 240
    const IMAGE_NODE_HEIGHT = 180
    const imageInputRef = useRef<HTMLInputElement | null>(null)
    /** Where the pending picker-created image should land; null = viewport center. */
    const pendingImagePointRef = useRef<Point | null>(null)

    const createImageNodeAt = (file: string, at?: Point) => {
      const root = rootRef.current
      const centerScreen =
        root === null ? { x: 0, y: 0 } : { x: root.clientWidth / 2, y: root.clientHeight / 2 }
      const preferred = screenToCanvas(centerScreen, viewport)
      const occupied = indexNodeBoxes(canvasRef.current).map((b) => b.box)
      const point =
        at ??
        findFreeSpot(preferred, { width: IMAGE_NODE_WIDTH, height: IMAGE_NODE_HEIGHT }, occupied)
      const id = newId()
      const node: SpatialNode = {
        id,
        type: 'file',
        x: Math.round(point.x - IMAGE_NODE_WIDTH / 2),
        y: Math.round(point.y - IMAGE_NODE_HEIGHT / 2),
        width: IMAGE_NODE_WIDTH,
        height: IMAGE_NODE_HEIGHT,
        file,
      }
      applyResult({
        state: { kind: 'idle' },
        commands: [{ kind: 'create-node', node }],
        selectedId: id,
      })
      panToShow({ x: node.x, y: node.y, width: node.width, height: node.height })
    }

    /** Stores the image via the host seam, then creates the node. */
    const addImageFile = (file: File, at?: Point) => {
      if (onAddImage === undefined || !file.type.startsWith('image/')) return
      void onAddImage(file).then((ref) => {
        if (ref !== undefined) createImageNodeAt(ref, at)
      })
    }

    /** The one place a stored URL is turned into navigation. noopener keeps
     * the canvas tab unreachable from the opened page, and the scheme guard
     * holds HERE (not only in the dialog) because canvases arrive via sync
     * and import — a hostile javascript:/data: URL must never reach
     * window.open. */
    const openLinkNode = (node: Extract<SpatialNode, { type: 'link' }>) => {
      if (!isFollowableUrl(node.url)) return
      window.open(node.url, '_blank', 'noopener,noreferrer')
    }

    /**
     * The free-spot cascade can push a palette-created node outside the
     * visible viewport, leaving the user staring at an unchanged canvas.
     * When the created box does not fully fit on screen, pan (keeping the
     * zoom) so it sits centered — creation is always visible feedback.
     */
    const panToShow = (box: Box) => {
      const root = rootRef.current
      if (root === null) return
      const topLeft = canvasToScreen({ x: box.x, y: box.y }, viewport)
      const bottomRight = canvasToScreen({ x: box.x + box.width, y: box.y + box.height }, viewport)
      const fits =
        topLeft.x >= 0 &&
        topLeft.y >= 0 &&
        bottomRight.x <= root.clientWidth &&
        bottomRight.y <= root.clientHeight
      if (fits) return
      const centerX = box.x + box.width / 2
      const centerY = box.y + box.height / 2
      setViewport((vp) => ({
        ...vp,
        x: centerX - root.clientWidth / 2 / vp.zoom,
        y: centerY - root.clientHeight / 2 / vp.zoom,
      }))
    }

    const GROUP_FRAME_WIDTH = 320
    const GROUP_FRAME_HEIGHT = 200
    /** Padding between a grouped selection's bounds and its new frame. */
    const GROUP_PADDING_PX = 24

    const newId = () =>
      createId?.() ??
      (typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : String(Math.random()))

    const createGroupAtViewportCenter = (at?: Point) => {
      const root = rootRef.current
      const centerScreen =
        root === null ? { x: 0, y: 0 } : { x: root.clientWidth / 2, y: root.clientHeight / 2 }
      const preferred = screenToCanvas(centerScreen, viewport)
      const occupied = indexNodeBoxes(canvasRef.current).map((b) => b.box)
      const point =
        at ??
        findFreeSpot(preferred, { width: GROUP_FRAME_WIDTH, height: GROUP_FRAME_HEIGHT }, occupied)
      const id = newId()
      applyResult({
        state: { kind: 'idle' },
        commands: [
          {
            kind: 'create-group',
            node: {
              id,
              type: 'group',
              x: Math.round(point.x - GROUP_FRAME_WIDTH / 2),
              y: Math.round(point.y - GROUP_FRAME_HEIGHT / 2),
              width: GROUP_FRAME_WIDTH,
              height: GROUP_FRAME_HEIGHT,
            },
          },
        ],
        selectedId: id,
      })
      panToShow({
        x: Math.round(point.x - GROUP_FRAME_WIDTH / 2),
        y: Math.round(point.y - GROUP_FRAME_HEIGHT / 2),
        width: GROUP_FRAME_WIDTH,
        height: GROUP_FRAME_HEIGHT,
      })
    }

    /** Frames the current multi-selection: enclosing box + padding. */
    const groupSelection = (memberIds: readonly string[]) => {
      const members = canvasRef.current.nodes.filter((n) => memberIds.includes(n.id))
      if (members.length === 0) return
      const minX = Math.min(...members.map((n) => n.x)) - GROUP_PADDING_PX
      const minY = Math.min(...members.map((n) => n.y)) - GROUP_PADDING_PX
      const maxX = Math.max(...members.map((n) => n.x + n.width)) + GROUP_PADDING_PX
      const maxY = Math.max(...members.map((n) => n.y + n.height)) + GROUP_PADDING_PX
      const id = newId()
      applyResult({
        state: { kind: 'idle' },
        commands: [
          {
            kind: 'create-group',
            node: {
              id,
              type: 'group',
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
            },
          },
        ],
        selectedId: id,
      })
      setExtraIds(new Set())
    }

    return (
      <div
        ref={rootRef}
        data-testid={testId}
        // The canvas is a drawing surface, not prose: a drag means marquee or
        // pan, and Select All means every NODE. Leaving it text-selectable let
        // the browser paint its own selection across the chrome — reported
        // after a Select All. Text stays selectable where text is edited (see
        // TextNodeEditor).
        className={`select-none ${className ?? ''}`.trimEnd()}
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
          width: '100%',
          height: '100%',
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
          if (onAddImage !== undefined && e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
          }
        }}
        onDrop={(e) => {
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
          const fragment = copySelection()
          if (fragment === null) return
          e.preventDefault()
          e.clipboardData?.setData('text/plain', JSON.stringify(fragment))
          deleteSelectionAsBatch()
        }}
        onPaste={(e) => {
          if (isTextEntryEvent(e.nativeEvent)) return
          // Content cascade (Excalidraw's shape): image file, then our own
          // JSON, then any other text as a note. Only a completely empty
          // clipboard falls through untouched.
          const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
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
        onLostPointerCapture={handlePointerCancel}
        onKeyDown={handleKeyDown}
      >
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
        {/* The OOUI creation surface: every canvas is empty until a node
          exists and double-click-empty-space has no visible cue, so the
          palette is the always-visible, keyboard-reachable way in. Fixed to
          the bottom edge outside the pan/zoom transform. */}
        <ToolPalette
          // Hand mode is view-only, so the dock's leading slot shows VIEW
          // controls (zoom in/out, 100% reset, center content) instead of
          // the host's EDIT history cluster — undo/redo has nothing to act
          // on in a mode where no press can change the canvas.
          leading={
            tool === 'hand' ? (
              <>
                <button
                  type="button"
                  data-testid="zoom-out-button"
                  aria-label="Zoom out"
                  onClick={() => zoomAtViewportCenter(1 / ZOOM_STEP_FACTOR)}
                  className={TOOL_BUTTON_CLASS}
                >
                  <ZoomOut aria-hidden="true" className="size-4" />
                </button>
                <button
                  type="button"
                  data-testid="zoom-reset-button"
                  aria-label="Reset zoom to 100%"
                  onClick={() => zoomAtViewportCenter(1 / viewport.zoom)}
                  className={`${DOCK_WIDE_BUTTON_CLASS} text-xs tabular-nums`}
                >
                  {Math.round(viewport.zoom * 100)}%
                </button>
                <button
                  type="button"
                  data-testid="zoom-in-button"
                  aria-label="Zoom in"
                  onClick={() => zoomAtViewportCenter(ZOOM_STEP_FACTOR)}
                  className={TOOL_BUTTON_CLASS}
                >
                  <ZoomIn aria-hidden="true" className="size-4" />
                </button>
                <button
                  type="button"
                  data-testid="zoom-fit-button"
                  aria-label="Zoom to fit"
                  onClick={() => {
                    frameContent()
                  }}
                  className={TOOL_BUTTON_CLASS}
                >
                  <Focus aria-hidden="true" className="size-4" />
                </button>
              </>
            ) : (
              paletteLeading
            )
          }
          onCreateNode={createNodeAtViewportCenter}
          onCreateLink={() => setLinkDialog({ mode: 'create' })}
          onCreateGroup={createGroupAtViewportCenter}
          onCreateCanvasRef={
            fileRefOptions === undefined ? undefined : () => setCanvasPicker({ mode: 'create' })
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
              setSelectedId(null)
              setExtraIds(new Set())
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
              if (file !== undefined) {
                addImageFile(file, pendingImagePointRef.current ?? undefined)
                pendingImagePointRef.current = null
              }
            }}
          />
        )}
        {contextMenu !== null && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            items={(() => {
              const node =
                contextMenu.nodeId === undefined
                  ? undefined
                  : canvas.nodes.find((n) => n.id === contextMenu.nodeId)
              const edge =
                contextMenu.edgeId === undefined
                  ? undefined
                  : canvas.edges.find((entry) => entry.id === contextMenu.edgeId)
              // The swatch chips preview the CURRENT mode's preset strokes so
              // the picker shows what will actually render; the stored value
              // stays the semantic slot ('1'..'6'), never a resolved hex.
              const presetSwatches = (
                theme === 'dark' ? SPATIAL_DARK_PALETTE : SPATIAL_LIGHT_PALETTE
              ).presets
              const presetEntries: readonly {
                readonly key: SpatialPresetKey
                readonly name: string
              }[] = [
                { key: '1', name: 'Red' },
                { key: '2', name: 'Orange' },
                { key: '3', name: 'Yellow' },
                { key: '4', name: 'Green' },
                { key: '5', name: 'Cyan' },
                { key: '6', name: 'Purple' },
              ]
              const colorRow = (
                current: CanvasColor | undefined,
                apply: (color: CanvasColor | undefined) => void,
              ) => ({
                kind: 'options' as const,
                label: 'Color',
                options: [
                  {
                    label: 'default',
                    ariaLabel: 'Default',
                    icon: <SquareDashed />,
                    selected: current === undefined,
                    onSelect: () => apply(undefined),
                  },
                  ...presetEntries.map((entry) => ({
                    label: entry.key,
                    ariaLabel: entry.name,
                    icon: (
                      // Paint-critical props are inline, not utility classes:
                      // a default-inline span ignores width/height entirely
                      // (it laid out 0x0 live), and the chip must also paint
                      // where the app stylesheet is absent.
                      <span
                        style={{
                          display: 'block',
                          width: 14,
                          height: 14,
                          borderRadius: '50%',
                          backgroundColor: presetSwatches[entry.key].stroke,
                        }}
                      />
                    ),
                    selected: current === entry.key,
                    onSelect: () => apply(entry.key),
                  })),
                ],
              })
              if (node === undefined && edge !== undefined) {
                // A locked edge offers exactly one action. Everything else in
                // this branch — delete, label, arrowheads, sides, colour —
                // is a mutation the lock exists to refuse.
                if (isEdgeLocked(edge.id)) {
                  return [
                    {
                      label: 'Unlock',
                      icon: <LockOpen />,
                      onSelect: () => onToggleEdgeLock?.(edge.id, false),
                    },
                  ]
                }
                // Property pickers are inline option rows (one tap per
                // choice, menu stays open) — a cycling item costs an
                // open-tap-reopen per step. Sections group the menu:
                // actions, then properties, then the destructive entry.
                // Arrow direction reads the JSON Canvas defaults (fromEnd
                // none, toEnd arrow).
                const fromEnd = edge.fromEnd ?? 'none'
                const toEnd = edge.toEnd ?? 'arrow'
                const arrowStates = [
                  { label: '→', ariaLabel: 'Forward', fromEnd: 'none', toEnd: 'arrow' },
                  { label: '↔', ariaLabel: 'Both', fromEnd: 'arrow', toEnd: 'arrow' },
                  { label: '←', ariaLabel: 'Backward', fromEnd: 'arrow', toEnd: 'none' },
                  { label: '−', ariaLabel: 'None', fromEnd: 'none', toEnd: 'none' },
                ] as const
                const applyEdgeCommand = (command: EditorCommand) =>
                  applyResult({ state: { kind: 'idle' }, commands: [command] })
                // Excel-border-style side pickers: a rectangle with the
                // pinned side emphasized; dashed = unpinned (auto).
                const SIDES = [
                  { label: 'auto', ariaLabel: 'Auto', icon: <SquareDashed />, side: undefined },
                  { label: 'top', ariaLabel: 'Top', icon: <PanelTop />, side: 'top' },
                  { label: 'right', ariaLabel: 'Right', icon: <PanelRight />, side: 'right' },
                  { label: 'bottom', ariaLabel: 'Bottom', icon: <PanelBottom />, side: 'bottom' },
                  { label: 'left', ariaLabel: 'Left', icon: <PanelLeft />, side: 'left' },
                ] as const
                const sideRow = (endpoint: 'from' | 'to') => {
                  const current = endpoint === 'from' ? edge.fromSide : edge.toSide
                  return {
                    kind: 'options' as const,
                    label: endpoint === 'from' ? 'From side' : 'To side',
                    options: SIDES.map((entry) => ({
                      label: entry.label,
                      icon: entry.icon,
                      ariaLabel: entry.ariaLabel,
                      selected: current === entry.side,
                      onSelect: () =>
                        applyEdgeCommand({
                          kind: 'set-edge-side',
                          id: edge.id,
                          endpoint,
                          side: entry.side,
                        }),
                    })),
                  }
                }
                return [
                  {
                    label: 'Edit label',
                    icon: <Tag />,
                    onSelect: () => setEdgeLabelEditId(edge.id),
                  },
                  { kind: 'separator' as const },
                  {
                    kind: 'options' as const,
                    label: 'Arrows',
                    options: arrowStates.map((state) => ({
                      label: state.label,
                      ariaLabel: state.ariaLabel,
                      selected: state.fromEnd === fromEnd && state.toEnd === toEnd,
                      onSelect: () =>
                        applyEdgeCommand({
                          kind: 'set-edge-ends',
                          id: edge.id,
                          fromEnd: state.fromEnd,
                          toEnd: state.toEnd,
                        }),
                    })),
                  },
                  sideRow('from'),
                  sideRow('to'),
                  colorRow(edge.color, (color) =>
                    applyEdgeCommand({ kind: 'set-edge-color', id: edge.id, color }),
                  ),
                  ...(edgeLockEnabled
                    ? [
                        {
                          label: 'Lock',
                          icon: <LockIcon />,
                          onSelect: () => {
                            onToggleEdgeLock?.(edge.id, true)
                            setSelectedEdgeId(null)
                          },
                        },
                      ]
                    : []),
                  { kind: 'separator' as const },
                  {
                    label: 'Delete',
                    icon: <Trash2 />,
                    danger: true,
                    onSelect: () => {
                      applyResult({
                        state: { kind: 'idle' },
                        commands: [{ kind: 'delete-edge', id: edge.id } as const],
                      })
                      setSelectedEdgeId(null)
                    },
                  },
                ]
              }
              if (node === undefined) {
                // The same creation set as the dock's + menu, anchored at
                // the click point — "here" is exactly the information the
                // bottom dock cannot express.
                const emptyItems: ContextMenuItem[] = [
                  ...(hasClipboardFragment()
                    ? [
                        {
                          label: 'Paste here',
                          icon: <ClipboardPaste />,
                          onSelect: () => {
                            pasteClipboard(contextMenu.point)
                          },
                        },
                        { kind: 'separator' } as const,
                      ]
                    : []),
                  {
                    label: 'Add note here',
                    icon: <StickyNote />,
                    onSelect: () => createNodeAt(contextMenu.point),
                  },
                  {
                    label: 'Add link here',
                    icon: <Link />,
                    onSelect: () => setLinkDialog({ mode: 'create', point: contextMenu.point }),
                  },
                  {
                    label: 'Add group here',
                    icon: <Frame />,
                    onSelect: () => createGroupAtViewportCenter(contextMenu.point),
                  },
                ]
                if (fileRefOptions !== undefined) {
                  emptyItems.push({
                    label: 'Add canvas here',
                    icon: <FileBox />,
                    onSelect: () => setCanvasPicker({ mode: 'create', point: contextMenu.point }),
                  })
                }
                if (onAddImage !== undefined) {
                  emptyItems.push({
                    label: 'Add image here',
                    icon: <ImageIcon />,
                    onSelect: () => {
                      pendingImagePointRef.current = contextMenu.point
                      imageInputRef.current?.click()
                    },
                  })
                }
                // Empty space IS the canvas, so canvas-wide settings are acted
                // on from here — the recorded OOUI rule puts actions on an
                // existing object with that object, and keeps the dock's "+"
                // menu for things that do not exist yet.
                //
                // Provisional placement: a canvas with several settings wants
                // its own surface rather than a growing context menu.
                const currentRouting = canvas['x-whiteboard']?.edgeRouting?.style ?? 'straight'
                emptyItems.push({ kind: 'separator' })
                emptyItems.push({
                  kind: 'options',
                  label: 'Edge routing',
                  options: EDGE_ROUTING_CHOICES.map(({ style, label }) => ({
                    key: style,
                    label,
                    selected: currentRouting === style,
                    onSelect: () => {
                      const command: EditorCommand = { kind: 'set-edge-routing', style }
                      onChange(applyCommand(canvasRef.current, command), command)
                    },
                  })),
                })
                return emptyItems
              }
              const items: ContextMenuItem[] = []
              if (node.type === 'group') {
                items.push({
                  label: 'Edit label',
                  icon: <Tag />,
                  onSelect: () => setGroupLabelEditId(node.id),
                })
                items.push({ kind: 'separator' })
              }
              // Framing an existing multi-selection is reached from any of
              // its members — the frame encloses every selected node,
              // including group frames: nesting is geometric in JSON Canvas,
              // and containment moves already handle nested frames.
              if (extraIds.size > 0) {
                items.push({
                  label: 'Group selection',
                  icon: <Frame />,
                  onSelect: () => groupSelection([node.id, ...extraIds]),
                })
                items.push({ kind: 'separator' })
              }
              if (node.type === 'file' && isImageFileRef?.(node.file) !== true) {
                if (onOpenFileRef !== undefined) {
                  items.push({
                    label: 'Open canvas',
                    icon: <ExternalLink />,
                    onSelect: () => onOpenFileRef(node.file, node.subpath),
                  })
                }
                if (fileRefOptions !== undefined) {
                  items.push({
                    label: 'Change target',
                    icon: <FileBox />,
                    onSelect: () => setCanvasPicker({ mode: 'retarget', nodeId: node.id }),
                  })
                }
                if (onOpenFileRef !== undefined || fileRefOptions !== undefined) {
                  items.push({ kind: 'separator' })
                }
              }
              if (node.type === 'link') {
                items.push({
                  label: 'Open link',
                  icon: <ExternalLink />,
                  onSelect: () => openLinkNode(node),
                })
                items.push({
                  label: 'Edit URL',
                  icon: <Pencil />,
                  onSelect: () => setLinkDialog({ mode: 'edit', nodeId: node.id }),
                })
                items.push({ kind: 'separator' })
              }
              if (node.type === 'text') {
                items.push({
                  label: 'Edit text',
                  icon: <Pencil />,
                  onSelect: () => {
                    applyResult(
                      reduceGesture(gestureState, canvas, {
                        type: 'start-text-edit',
                        nodeId: node.id,
                        text: node.text,
                      }),
                    )
                  },
                })
                // Same grouping rule as the edge menu: the destructive
                // entry sits in its own section.
                items.push({ kind: 'separator' })
              }
              // Touch path to Cmd/Ctrl+D (see shortcuts.ts). The menu's
              // right-click already made this node the primary selection,
              // so the shared handler clones the full multi-selection.
              // A locked node's menu offers exactly one action: unlock.
              // Showing Delete/Edit next to a lock the user deliberately
              // set would make the lock read as decorative.
              if (isLocked(node.id)) {
                return [
                  {
                    label: 'Unlock',
                    icon: <LockOpen />,
                    onSelect: () => onToggleNodeLock?.(node.id, false),
                  },
                ]
              }
              items.push({
                label: 'Copy',
                icon: <CopyIcon />,
                onSelect: () => {
                  copySelection()
                },
              })
              items.push({
                label: 'Cut',
                icon: <Scissors />,
                onSelect: () => {
                  // Menu path mirrors the native cut: copy, then remove.
                  if (copySelection() !== null) deleteSelectionAsBatch()
                },
              })
              items.push({
                label: 'Duplicate',
                icon: <CopyIcon />,
                onSelect: () => {
                  duplicateSelection()
                },
              })
              items.push(
                colorRow(node.color, (color) =>
                  applyResult({
                    state: { kind: 'idle' },
                    commands: [{ kind: 'set-node-color', id: node.id, color }],
                  }),
                ),
              )
              // Z-order as one-tap options — the touch path to the [ / ]
              // keyboard shortcuts (see shortcuts.ts). Not a picker: no
              // option is ever "selected", each tap applies a move.
              items.push({
                kind: 'options',
                label: 'Order',
                options: [
                  {
                    label: 'back',
                    ariaLabel: 'Send to back',
                    icon: <SendToBack />,
                    selected: false,
                    onSelect: () => reorderSelection('back'),
                  },
                  {
                    label: 'backward',
                    ariaLabel: 'Send backward',
                    icon: <ChevronDown />,
                    selected: false,
                    onSelect: () => reorderSelection('backward'),
                  },
                  {
                    label: 'forward',
                    ariaLabel: 'Bring forward',
                    icon: <ChevronUp />,
                    selected: false,
                    onSelect: () => reorderSelection('forward'),
                  },
                  {
                    label: 'front',
                    ariaLabel: 'Bring to front',
                    icon: <BringToFront />,
                    selected: false,
                    onSelect: () => reorderSelection('front'),
                  },
                ],
              })
              // Align needs a second box to align TO, and distribute needs a
              // middle one to place — so each row appears only once its
              // action means something, rather than sitting there inert.
              const alignableCount = extraIds.size + 1
              if (alignableCount >= 2) {
                items.push({
                  kind: 'options',
                  label: 'Align',
                  options: (
                    [
                      ['left', 'Align left', <AlignStartVertical key="l" />],
                      ['center-x', 'Align centre horizontally', <AlignCenterVertical key="cx" />],
                      ['right', 'Align right', <AlignEndVertical key="r" />],
                      ['top', 'Align top', <AlignStartHorizontal key="t" />],
                      ['center-y', 'Align centre vertically', <AlignCenterHorizontal key="cy" />],
                      ['bottom', 'Align bottom', <AlignEndHorizontal key="b" />],
                    ] as const
                  ).map(([mode, ariaLabel, icon]) => ({
                    label: mode,
                    ariaLabel,
                    icon,
                    selected: false,
                    onSelect: () => applyBoxMoves(alignBoxes(selectedAlignableBoxes(), mode)),
                  })),
                })
              }
              if (alignableCount >= 3) {
                items.push({
                  kind: 'options',
                  label: 'Distribute',
                  options: (
                    [
                      [
                        'horizontal',
                        'Distribute horizontally',
                        <AlignHorizontalDistributeCenter key="h" />,
                      ],
                      [
                        'vertical',
                        'Distribute vertically',
                        <AlignVerticalDistributeCenter key="v" />,
                      ],
                    ] as const
                  ).map(([axis, ariaLabel, icon]) => ({
                    label: axis,
                    ariaLabel,
                    icon,
                    selected: false,
                    onSelect: () => applyBoxMoves(distributeBoxes(selectedAlignableBoxes(), axis)),
                  })),
                })
              }
              if (lockEnabled) {
                items.push({
                  label: 'Lock',
                  icon: <LockIcon />,
                  onSelect: () => onToggleNodeLock?.(node.id, true),
                })
              }
              items.push({ kind: 'separator' })
              items.push({
                label: 'Delete',
                icon: <Trash2 />,
                danger: true,
                onSelect: () => {
                  applyResult(
                    reduceGesture(gestureState, canvas, {
                      type: 'delete-selection',
                      nodeId: node.id,
                    }),
                  )
                },
              })
              return items
            })()}
          />
        )}
        {canvasPicker !== null && fileRefOptions !== undefined && (
          <CanvasPickerDialog
            title={canvasPicker.mode === 'create' ? 'Add canvas' : 'Change target'}
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
              setCanvasPicker(null)
            }}
            onCancel={() => setCanvasPicker(null)}
          />
        )}
        {linkDialog !== null && (
          <LinkUrlDialog
            title={linkDialog.mode === 'create' ? 'Add link' : 'Edit URL'}
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
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: bounds.x,
              top: bounds.y,
              // canvas-render's layoutMdastBlocks assigns no appearance to
              // markdown body text runs (they carry no `fill` attribute at
              // all), so they inherit this host element's SVG `fill`
              // instead — the seam that keeps body text visible on the dark
              // canvas surface without editing canvas-render itself. Any
              // element that DOES carry its own `fill` presentation
              // attribute is unaffected (presentation attributes win over
              // an inherited value).
              fill: editorTextFill(theme),
            }}
            // canvas-render's SVG serializer is the SOLE producer of this
            // string and escapes text/attrs (see svg/format.ts) — the same
            // already-reviewed reasoning as CanvasViewer.tsx's identical sink.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          {/* Editor-only iframe embeds for link nodes (never in exports).
              Rides the same transform as every canvas-space overlay; the
              LOD gate mirrors the canvas-embed thresholds. */}
          <LinkEmbedLayer
            canvas={canvas}
            shouldOffer={(node) =>
              node.width * viewport.zoom >= EXPAND_MIN_W &&
              node.height * viewport.zoom >= EXPAND_MIN_H
            }
          />
          {marquee !== null && (
            <svg
              data-testid="marquee-rect"
              aria-hidden="true"
              style={{
                position: 'absolute',
                overflow: 'visible',
                left: 0,
                top: 0,
                pointerEvents: 'none',
              }}
            >
              <rect
                x={Math.min(marquee.start.x, marquee.current.x)}
                y={Math.min(marquee.start.y, marquee.current.y)}
                width={Math.abs(marquee.current.x - marquee.start.x)}
                height={Math.abs(marquee.current.y - marquee.start.y)}
                fill="#2563eb"
                fillOpacity={0.08}
                stroke="#2563eb"
                strokeWidth={1 / viewport.zoom}
                strokeDasharray={`${4 / viewport.zoom} ${3 / viewport.zoom}`}
              />
            </svg>
          )}
          {snapGuides !== null && snapGuides.x.length + snapGuides.y.length > 0 && (
            <svg
              data-testid="snap-guides"
              aria-hidden="true"
              style={{
                position: 'absolute',
                overflow: 'visible',
                left: 0,
                top: 0,
                pointerEvents: 'none',
              }}
            >
              {snapGuides.x.map((x) => (
                <line
                  key={`x${x}`}
                  data-axis="x"
                  x1={x}
                  x2={x}
                  y1={guideSpan.minY}
                  y2={guideSpan.maxY}
                  stroke="#e11d48"
                  strokeWidth={1 / viewport.zoom}
                />
              ))}
              {snapGuides.y.map((y) => (
                <line
                  key={`y${y}`}
                  data-axis="y"
                  x1={guideSpan.minX}
                  x2={guideSpan.maxX}
                  y1={y}
                  y2={y}
                  stroke="#e11d48"
                  strokeWidth={1 / viewport.zoom}
                />
              ))}
            </svg>
          )}
          {/* Which nodes are in the selection. The overlay above outlines the
            region the handles act on, which says nothing about membership —
            outlining only the extras left the primary looking untouched, so a
            Select All over three nodes read as though it had skipped one. */}
          {isMultiSelection && (
            <svg
              data-testid="member-outlines"
              aria-hidden="true"
              style={{
                position: 'absolute',
                overflow: 'visible',
                left: 0,
                top: 0,
                pointerEvents: 'none',
              }}
            >
              {selectionMembers.map(({ id, box }) => (
                <rect
                  key={id}
                  x={box.x}
                  y={box.y}
                  width={box.width}
                  height={box.height}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth={1.5 / viewport.zoom}
                  opacity={0.7}
                />
              ))}
            </svg>
          )}
          {selection !== undefined && selectionBox !== undefined && (
            <SelectionOverlay
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
              onEditRequest={
                !isMultiSelection && selectedNode?.type === 'text'
                  ? () => {
                      applyResult(
                        reduceGesture(gestureState, canvas, {
                          type: 'start-text-edit',
                          nodeId: selectedNode.id,
                          text: selectedNode.text,
                        }),
                      )
                    }
                  : undefined
              }
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
          {selectedEdgeId !== null &&
            (() => {
              const selected = edgePaths.find((edge) => edge.id === selectedEdgeId)
              if (selected === undefined || selected.path.length < 2) return null
              return (
                <svg
                  style={{
                    position: 'absolute',
                    overflow: 'visible',
                    left: 0,
                    top: 0,
                    pointerEvents: 'none',
                  }}
                >
                  <title>Selected connection</title>
                  <polyline
                    data-testid="edge-selection-highlight"
                    points={selected.path.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth={3}
                    strokeLinecap="round"
                  />
                </svg>
              )
            })()}
          {gestureState.kind === 'connecting' && (
            <svg
              style={{
                position: 'absolute',
                overflow: 'visible',
                left: 0,
                top: 0,
                pointerEvents: 'none',
              }}
            >
              <title>Connection targets</title>
              {/* Immediate acknowledgment that the connect ARMED: the
                rubber-band line only appears once the pointer moves, so a
                still hand needs the source node marked right away. */}
              {(() => {
                const source = boxes.find((b) => b.id === gestureState.fromNodeId)
                if (source === undefined) return null
                return (
                  <rect
                    data-testid="connect-source-indicator"
                    x={source.box.x - 2}
                    y={source.box.y - 2}
                    width={source.box.width + 4}
                    height={source.box.height + 4}
                    fill="none"
                    stroke="#2563eb"
                    strokeWidth={2}
                    strokeDasharray="6 3"
                  />
                )
              })()}
              {/* Named rather than aria-hidden for the same reason as the
                selection overlay: this subtree holds the focusable connection
                targets, so hiding it would remove the keyboard path. */}
              {/*
               * Keyboard path for completing a connection: while `connecting`,
               * every OTHER node gets a focusable target the pointer path
               * already reaches by hit-testing on pointerup. Tab to one and
               * press Enter/Space, matching `reducePointerUpConnecting`'s
               * targetNodeId contract exactly (invalid targets are the
               * fromNode itself, which is excluded below).
               */}
              {selectableBoxes
                .filter((b) => b.id !== gestureState.fromNodeId)
                .map((b) => (
                  // biome-ignore lint/a11y/useSemanticElements: must stay an SVG shape to hit-test at this node's canvas-space box under the ancestor pan/zoom transform; role+tabIndex+onKeyDown reproduce native <button> semantics by hand.
                  <rect
                    key={b.id}
                    data-testid={`connect-target-${b.id}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Connect to node ${b.id}`}
                    x={b.box.x}
                    y={b.box.y}
                    width={b.box.width}
                    height={b.box.height}
                    fill="transparent"
                    style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      applyResult(
                        reduceGesture(
                          gestureState,
                          canvas,
                          {
                            type: 'pointerup',
                            point: { x: b.box.x, y: b.box.y },
                            targetNodeId: b.id,
                          },
                          { createId },
                        ),
                      )
                    }}
                  />
                ))}
            </svg>
          )}
          {edgeLabelEditId !== null &&
            (() => {
              const edge = canvas.edges.find((entry) => entry.id === edgeLabelEditId)
              const path = edgePaths.find((entry) => entry.id === edgeLabelEditId)?.path
              if (edge === undefined || path === undefined || path.length < 2) return null
              const mid = polylineMidpoint(path)
              return (
                <TextNodeEditor
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
          {gestureState.kind === 'editing-text' &&
            selectedNode?.type === 'text' &&
            selection !== undefined && (
              <TextNodeEditor
                box={selection.box}
                initialText={selectedNode.text}
                style={(() => {
                  const resolved = createEditorAppearance(theme).resolveNode(selectedNode)
                  const fill = resolved.appearance?.fill
                  return {
                    // The node's own fill when it has one; dark-mode nodes are
                    // unfilled outlines, so fall back to the canvas surface.
                    background:
                      fill !== undefined && fill !== 'none'
                        ? fill
                        : theme === 'dark'
                          ? 'oklch(0.145 0 0)'
                          : '#ffffff',
                    color: editorTextFill(theme),
                    fontFamily: SPATIAL_THEME_FONT_FAMILY,
                    fontSize: BODY_FONT_SIZE_PX,
                    // The rendered layout advances one font-size per line.
                    lineHeight: `${BODY_FONT_SIZE_PX}px`,
                    padding: SPATIAL_THEME_GEOMETRY.paddingPx,
                    borderRadius: resolved.radius,
                  }
                })()}
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
    )
  },
)
