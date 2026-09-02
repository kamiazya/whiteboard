/**
 * The node branch: group label/background, file/link/text verbs, the
 * locked-node [Unlock] short-circuit, copy/cut/duplicate, recolor with
 * multi-selection targeting, the facet doorway, order/align/distribute/
 * tidy/lock, and the properties/facets/verbs/delete band order.
 */
import { tidyNodes } from '@kamiazya/whiteboard-canvas-render'
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
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
  Copy as CopyIcon,
  CopyPlus,
  ExternalLink,
  FileBox,
  Frame,
  Image as ImageIcon,
  ImageOff,
  Lock as LockIcon,
  LockOpen,
  MessageSquarePlus,
  Pencil,
  Scissors,
  SendToBack,
  Sparkles,
  Tag,
  Trash2,
} from 'lucide-react'
import type { MutableRefObject } from 'react'
import type { ResolvedTheme } from '../../../hooks/useThemeMode.js'
import type { AlignableBox } from '../align.js'
import { alignBoxes, distributeBoxes } from '../align.js'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'
import type { FileRefOption } from '../DocumentPickerDialog.js'
import { nodePropertyItems } from '../facet-widgets/index.js'
import { type GestureState, reduceGesture } from '../gestures.js'
import { colorRow } from './color-row.js'

export interface NodeMenuItemsInput {
  readonly node: SpatialNode
  readonly canvas: SpatialCanvas
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  readonly theme: ResolvedTheme
  readonly gestureState: GestureState
  readonly isLocked: (nodeId: string) => boolean
  readonly lockEnabled: boolean
  readonly isEdgeLocked: (edgeId: string) => boolean
  readonly extraIds: ReadonlySet<string>
  readonly selectedId: string | null
  readonly isImageFileRef?: (file: string) => boolean
  readonly missingFileRef?: (file: string) => boolean
  readonly fileRefOptions?: readonly FileRefOption[]
  readonly facetRegistry: FacetRegistry
  readonly selectedAlignableBoxes: () => readonly AlignableBox[]
  readonly pendingBackgroundGroupIdRef: MutableRefObject<string | null>
  readonly imageInputRef: MutableRefObject<HTMLInputElement | null>
  readonly applyResult: CanvasCommands['applyResult']
  readonly applyBoxMoves: CanvasCommands['applyBoxMoves']
  readonly copySelection: CanvasCommands['copySelection']
  readonly cutSelection: CanvasCommands['cutSelection']
  readonly duplicateSelection: CanvasCommands['duplicateSelection']
  readonly reorderSelection: CanvasCommands['reorderSelection']
  readonly groupSelection: CanvasCommands['groupSelection']
  readonly openLinkNode: CanvasCommands['openLinkNode']
  readonly onOpenFileRef: CanvasCommands['onOpenFileRef']
  readonly onAddImage: CanvasCommands['onAddImage']
  readonly onToggleNodeLock: CanvasCommands['onToggleNodeLock']
  readonly setGroupLabelEditId: CanvasCommands['setGroupLabelEditId']
  readonly setLinkDialog: CanvasCommands['setLinkDialog']
  readonly setDocumentPicker: CanvasCommands['setDocumentPicker']
  readonly setFacetPanelOpen: CanvasCommands['setFacetPanelOpen']
  readonly setCommentCompose: CanvasCommands['setCommentCompose']
}

export function nodeMenuItems({
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
}: NodeMenuItemsInput): ContextMenuItem[] {
  // The catalog's band order, shared by both vessels (list and grid):
  // 1. properties (state pickers — the menu stays open),
  // 2. verbs (one-shot — the menu closes),
  // 3. the destructive entry, alone at the bottom.
  const properties: ContextMenuItem[] = []
  const verbs: ContextMenuItem[] = []
  // Anchored at the node's top-right corner, the same convention the MCP
  // `comment` op uses, so a comment reads the same whoever made it. A
  // comment is ABOUT the node and never touches it, which is why it is
  // the one verb a LOCKED node keeps beside Unlock.
  const commentOnThis: ContextMenuItem = {
    label: 'Comment on this',
    icon: <MessageSquarePlus />,
    onSelect: () =>
      setCommentCompose({
        point: { x: node.x + node.width, y: node.y },
        targetNodeId: node.id,
      }),
  }
  if (node.type === 'group') {
    verbs.push({
      label: 'Edit label',
      icon: <Tag />,
      onSelect: () => setGroupLabelEditId(node.id),
    })
    if (onAddImage !== undefined) {
      verbs.push({
        label: 'Set background image',
        icon: <ImageIcon />,
        onSelect: () => {
          pendingBackgroundGroupIdRef.current = node.id
          imageInputRef.current?.click()
        },
      })
    }
    if (node.background !== undefined) {
      const background = node.background
      const applyStyle = (backgroundStyle: 'cover' | 'ratio') =>
        applyResult({
          state: { kind: 'idle' },
          commands: [{ kind: 'set-group-background', id: node.id, background, backgroundStyle }],
        })
      properties.push({
        kind: 'options',
        label: 'Background',
        options: [
          {
            label: 'Cover',
            ariaLabel: 'Cover',
            selected: node.backgroundStyle !== 'ratio',
            onSelect: () => applyStyle('cover'),
          },
          {
            label: 'Fit',
            ariaLabel: 'Fit',
            selected: node.backgroundStyle === 'ratio',
            onSelect: () => applyStyle('ratio'),
          },
        ],
      })
      verbs.push({
        label: 'Remove background',
        icon: <ImageOff />,
        onSelect: () =>
          applyResult({
            state: { kind: 'idle' },
            commands: [{ kind: 'set-group-background', id: node.id }],
          }),
      })
    }
  }
  // Framing an existing multi-selection is reached from any of
  // its members — the frame encloses every selected node,
  // including group frames: nesting is geometric in JSON Canvas,
  // and containment moves already handle nested frames.
  if (extraIds.size > 0) {
    verbs.push({
      label: 'Group selection',
      icon: <Frame />,
      onSelect: () => groupSelection([node.id, ...extraIds]),
    })
  }
  if (node.type === 'file' && isImageFileRef?.(node.file) !== true) {
    // A missing target makes Open a dead end (worse: the daemon's
    // path routes lazily create, so following would mint an empty
    // canvas under the dangling ref). Change target stays — it is
    // the repair affordance.
    if (onOpenFileRef !== undefined && missingFileRef?.(node.file) !== true) {
      verbs.push({
        label: 'Open canvas',
        icon: <ExternalLink />,
        onSelect: () => onOpenFileRef(node.file, node.subpath),
      })
    }
    if (fileRefOptions !== undefined) {
      verbs.push({
        label: 'Change target',
        icon: <FileBox />,
        onSelect: () => setDocumentPicker({ mode: 'retarget', nodeId: node.id }),
      })
    }
  }
  if (node.type === 'link') {
    verbs.push({
      label: 'Open link',
      icon: <ExternalLink />,
      onSelect: () => openLinkNode(node),
    })
    verbs.push({
      label: 'Edit URL',
      icon: <Pencil />,
      onSelect: () => setLinkDialog({ mode: 'edit', nodeId: node.id }),
    })
  }
  if (node.type === 'text') {
    verbs.push({
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
      commentOnThis,
    ]
  }
  verbs.push({
    label: 'Copy',
    icon: <CopyIcon />,
    onSelect: () => {
      copySelection()
    },
  })
  verbs.push({
    label: 'Cut',
    icon: <Scissors />,
    onSelect: () => {
      // The cut defers its delete: cutSelection holds the selection as
      // a ghost until the paste resolves it.
      cutSelection()
    },
  })
  verbs.push({
    label: 'Duplicate',
    // Not CopyIcon: in the icon-only grid vessel, Copy and Duplicate
    // with one glyph would be indistinguishable side by side.
    icon: <CopyPlus />,
    onSelect: () => {
      duplicateSelection()
    },
  })
  properties.push(
    colorRow(theme, node.color, (color) => {
      // Recoloring FROM a multi-selection styles the whole
      // selected AREA: every member, and every edge that runs
      // between two members — the closest executable reading of
      // "select a region, recolor it". An edge leaving the
      // selection keeps its color (only one endpoint is inside),
      // and a target outside the selection styles itself alone.
      const members = new Set(selectedId !== null ? [selectedId, ...extraIds] : [])
      const nodeTargets = members.has(node.id) ? [...members] : [node.id]
      const edgeTargets =
        nodeTargets.length > 1
          ? canvas.edges.filter(
              (edge) =>
                !isEdgeLocked(edge.id) && members.has(edge.fromNode) && members.has(edge.toNode),
            )
          : []
      applyResult({
        state: { kind: 'idle' },
        commands: [
          ...nodeTargets.map((id) => ({ kind: 'set-node-color' as const, id, color })),
          ...edgeTargets.map((edge) => ({
            kind: 'set-edge-color' as const,
            id: edge.id,
            color,
          })),
        ],
      })
    }),
  )
  // Facets reach this surface as ONE doorway. This menu never names a
  // plugin or facet key (facet-wiring-guard.test.ts keeps it that way),
  // and now it does not carry their values either — an action menu runs
  // an entry and closes; a facet is state you adjust repeatedly.
  const facetItems = nodePropertyItems(facetRegistry, {
    openPanel: () => setFacetPanelOpen(true),
  })
  // Z-order as one-tap options — the touch path to the [ / ]
  // keyboard shortcuts (see shortcuts.ts). Not a picker: no
  // option is ever "selected", each tap applies a move.
  properties.push({
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
    properties.push({
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
    properties.push({
      kind: 'options',
      label: 'Distribute',
      options: (
        [
          ['horizontal', 'Distribute horizontally', <AlignHorizontalDistributeCenter key="h" />],
          ['vertical', 'Distribute vertically', <AlignVerticalDistributeCenter key="v" />],
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
  if (alignableCount >= 2) {
    verbs.push({
      label: 'Tidy',
      icon: <Sparkles />,
      onSelect: () =>
        applyBoxMoves(
          tidyNodes(canvasRef.current.nodes, {
            scope: new Set([node.id, ...extraIds]),
            locked: isLocked,
          }),
        ),
    })
  }
  if (lockEnabled) {
    verbs.push({
      label: 'Lock',
      icon: <LockIcon />,
      onSelect: () => onToggleNodeLock?.(node.id, true),
    })
  }
  verbs.push(commentOnThis)
  return [
    ...properties,
    // Extensions come after every core row, behind their own fence.
    ...facetItems,
    { kind: 'separator' as const },
    ...verbs,
    { kind: 'separator' as const },
    {
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
    },
  ]
}
