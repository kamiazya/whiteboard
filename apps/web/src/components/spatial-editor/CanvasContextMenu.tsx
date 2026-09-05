/** Right-click menu: node, edge, and empty-canvas actions. */

import type { EdgePathLookup } from '@kamiazya/whiteboard-canvas-render'
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { ClipboardFragment, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import type { MutableRefObject } from 'react'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import type { TextAnchor } from '../../lib/text-anchor.js'
import type { BoxMove } from './align.js'
import { alignableBoxesOf } from './align.js'
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js'
import { canvasMenuItems } from './context-menu-items/canvas-menu-items.js'
import { commentMenuItems } from './context-menu-items/comment-menu-items.js'
import { edgeMenuItems } from './context-menu-items/edge-menu-items.js'
import { nodeMenuItems } from './context-menu-items/node-menu-items.js'
import type { FileRefOption } from './DocumentPickerDialog.js'
import type { GestureResult, GestureState } from './gestures.js'
import type { Point } from './viewport.js'

/** Open right-click menu: screen position (root-relative) + hit target. */
export interface ContextMenuTarget {
  readonly x: number
  readonly y: number
  readonly nodeId: string | undefined
  readonly edgeId: string | undefined
  /** A comment's pin or bubble under the pointer: the menu is the comment's, not the canvas's. */
  readonly commentId?: string
  readonly point: Point
  /** The ⋯ control opens the same catalog in the icon-grid or sheet vessel. */
  readonly variant?: 'list' | 'grid' | 'sheet'
}

/**
 * `point` (canvas space) is present when creation came from the
 * empty-space context menu: the user already chose WHERE, so the node
 * lands there instead of the viewport-center free spot.
 */
export type LinkDialogState =
  | { readonly mode: 'create'; readonly point?: Point }
  | { readonly mode: 'edit'; readonly nodeId: string }

export type DocumentPickerState =
  | { readonly mode: 'create'; readonly point?: Point }
  | { readonly mode: 'retarget'; readonly nodeId: string }

/**
 * An open comment compose bubble: the anchor the comment will carry, plus
 * the node it is about when it came from a node's menu. The draft text
 * lives in the bubble itself — only the anchor is decided at menu time.
 */
export interface CommentComposeState {
  readonly point: Point
  readonly targetNodeId?: string
  /** The edge the comment is about; the bubble opens on its routed path. */
  readonly targetEdgeId?: string
  /**
   * A passage of a node's text (ADR-0026's text arm with a node reference):
   * the commit opens a THREAD rather than a flat comment, since a flat
   * comment cannot carry a passage. `targetNodeId` names the node as well,
   * so the bubble opens at the node's corner like a node comment.
   */
  readonly passage?: TextAnchor
  /**
   * Present when the bubble edits an EXISTING comment rather than drafting
   * a new one: the commit rewrites that comment's text instead of creating.
   * `point` is then the comment's own anchor, so the bubble opens exactly
   * over the drawn one.
   */
  readonly editing?: { readonly id: string; readonly initialText: string }
}

/**
 * Everything the menu can DO, as one object.
 *
 * The menu is a command surface: thirty-six flat props made it read as a
 * component with thirty-six concerns, when twenty of them were the same
 * concern — verbs the editor exposes, the set the keyboard shortcuts invoke
 * too. Dialog-opening setters are included deliberately: from the menu's side
 * "edit this label" and "add a link" are commands, and that they happen to be
 * implemented as state setters is the editor's business.
 *
 * Data, predicates, and the image-insertion refs stay flat: they answer what
 * the menu SHOWS, not what it does.
 */
export interface CanvasCommands {
  readonly applyResult: (result: GestureResult) => void
  readonly applyBoxMoves: (moves: readonly BoxMove[]) => boolean
  readonly copySelection: () => ClipboardFragment | null
  /** Cut-flavoured copy: also records the cut surface for paste to reconnect. */
  readonly cutSelection: () => ClipboardFragment | null
  readonly pasteClipboard: (at?: Point) => boolean
  readonly duplicateSelection: () => boolean
  readonly reorderSelection: (placement: 'forward' | 'backward' | 'front' | 'back') => void
  readonly groupSelection: (memberIds: readonly string[]) => void
  readonly createNodeAt: (point: Point) => void
  readonly createGroupAtViewportCenter: (at?: Point) => void
  readonly openLinkNode: (node: Extract<SpatialNode, { type: 'link' }>) => void
  readonly onOpenFileRef?: (file: string, subpath?: string) => void
  readonly onAddImage?: (file: File) => Promise<string | undefined>
  readonly onToggleNodeLock?: (nodeId: string, locked: boolean) => void
  readonly onToggleEdgeLock?: (edgeId: string, locked: boolean) => void
  readonly setEdgeLabelEditId: (id: string | null) => void
  readonly setGroupLabelEditId: (id: string | null) => void
  readonly setSelectedEdgeId: (id: string | null) => void
  readonly setLinkDialog: (state: LinkDialogState | null) => void
  readonly setDocumentPicker: (state: DocumentPickerState | null) => void
  /** Opens the node's full facet editor — the point knows no domain. */
  readonly setFacetPanelOpen: (open: boolean) => void
  readonly setCommentCompose: (state: CommentComposeState | null) => void
  /** Per-user view state (ADR-0025 decision 2): resolved comments drawn, muted. */
  readonly showResolvedComments: boolean
  readonly setShowResolvedComments: (show: boolean) => void
}

export interface CanvasContextMenuProps {
  readonly commands: CanvasCommands
  readonly contextMenu: ContextMenuTarget
  readonly setContextMenu: (target: ContextMenuTarget | null) => void
  readonly canvas: SpatialCanvas
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  readonly edgePathOf: EdgePathLookup
  readonly theme: ResolvedTheme
  readonly gestureState: GestureState
  readonly isEdgeLocked: (edgeId: string) => boolean
  readonly fileRefOptions?: readonly FileRefOption[]
  readonly pendingImagePointRef: MutableRefObject<Point | null>
  readonly imageInputRef: MutableRefObject<HTMLInputElement | null>
  readonly pendingBackgroundGroupIdRef: MutableRefObject<string | null>
  readonly isLocked: (nodeId: string) => boolean
  readonly extraIds: ReadonlySet<string>
  readonly selectedId: string | null
  readonly isImageFileRef?: (file: string) => boolean
  /** Contribution source; a test seam — production uses the bundled registry. */
  readonly facetRegistry?: FacetRegistry
  readonly missingFileRef?: (file: string) => boolean
}

export function CanvasContextMenu({
  commands,
  contextMenu,
  setContextMenu,
  canvas,
  canvasRef,
  edgePathOf,
  theme,
  gestureState,
  isEdgeLocked,
  fileRefOptions,
  pendingImagePointRef,
  imageInputRef,
  pendingBackgroundGroupIdRef,
  isLocked,
  extraIds,
  selectedId,
  isImageFileRef,
  missingFileRef,
  facetRegistry = bundledFacetRegistry,
}: CanvasContextMenuProps) {
  const {
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
  } = commands

  // Both derive from whether the host wired the matching toggle callback —
  // without one, the menu has nothing to call, so the affordance stays
  // hidden rather than offering a lock that can never be released.
  const lockEnabled = onToggleNodeLock !== undefined
  const edgeLockEnabled = onToggleEdgeLock !== undefined
  // Read from canvasRef (not the `canvas` prop) so a menu action never
  // computes against a stale render closure.
  const selectedAlignableBoxes = () =>
    alignableBoxesOf(canvasRef.current.nodes, selectedId === null ? [] : [selectedId, ...extraIds])

  const node =
    contextMenu.nodeId === undefined
      ? undefined
      : canvas.nodes.find((n) => n.id === contextMenu.nodeId)
  const edge =
    contextMenu.edgeId === undefined
      ? undefined
      : canvas.edges.find((entry) => entry.id === contextMenu.edgeId)

  // A comment's menu is its own: it is not content, so none of the
  // node/edge/canvas verbs apply.
  const comment =
    contextMenu.commentId === undefined
      ? undefined
      : canvasRef.current['x-whiteboard']?.comments?.find(
          (entry) => entry.id === contextMenu.commentId,
        )

  const items: readonly ContextMenuItem[] =
    comment !== undefined
      ? commentMenuItems({ comment, canvasRef, edgePathOf, setCommentCompose, applyResult })
      : node === undefined && edge !== undefined
        ? edgeMenuItems({
            edge,
            point: contextMenu.point,
            setCommentCompose,
            theme,
            isEdgeLocked,
            edgeLockEnabled,
            applyResult,
            setEdgeLabelEditId,
            setSelectedEdgeId,
            onToggleEdgeLock,
          })
        : node === undefined
          ? canvasMenuItems({
              point: contextMenu.point,
              canvas,
              canvasRef,
              isLocked,
              fileRefOptions,
              onAddImage,
              pendingImagePointRef,
              imageInputRef,
              pasteClipboard,
              createNodeAt,
              setLinkDialog,
              createGroupAtViewportCenter,
              setDocumentPicker,
              applyBoxMoves,
              setCommentCompose,
              showResolvedComments,
              setShowResolvedComments,
            })
          : nodeMenuItems({
              node,
              canvas,
              canvasRef,
              theme,
              gestureState,
              isLocked,
              lockEnabled,
              isEdgeLocked,
              extraIds,
              selectedId,
              isImageFileRef,
              missingFileRef,
              fileRefOptions,
              facetRegistry,
              selectedAlignableBoxes,
              pendingBackgroundGroupIdRef,
              imageInputRef,
              applyResult,
              applyBoxMoves,
              copySelection,
              cutSelection,
              duplicateSelection,
              reorderSelection,
              groupSelection,
              openLinkNode,
              onOpenFileRef,
              onAddImage,
              onToggleNodeLock,
              setGroupLabelEditId,
              setLinkDialog,
              setDocumentPicker,
              setFacetPanelOpen,
              setCommentCompose,
            })

  return (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      variant={contextMenu.variant}
      onClose={() => setContextMenu(null)}
      items={items}
    />
  )
}
