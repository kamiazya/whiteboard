import type { AnnotationAnchor, ClipboardFragment, SpatialNode } from '@kamiazya/whiteboard-model'
import type { ImageStoreResult } from '../../lib/document-file-contract.js'
import type { Point } from '../../lib/spatial/viewport.js'
import type { BoxMove } from './align.js'
import type { GestureResult } from './gestures.js'

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
   * An anchor the flat comment cannot carry — a passage of a node's text,
   * a node set (ADR-0026's text arm with a node reference; the spatial arm
   * with `nodeIds`): the commit opens a THREAD rather than a flat comment.
   * `point` is where the bubble opens: the node's corner for a passage,
   * the selection's top-right corner for a set.
   */
  readonly threadAnchor?: AnnotationAnchor
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
  readonly openLinkNode: (node: SpatialNode) => void
  readonly onOpenFileRef?: (file: string, subpath?: string) => void
  readonly onAddImage?: (file: File) => Promise<ImageStoreResult>
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
