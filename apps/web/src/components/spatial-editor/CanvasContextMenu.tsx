/** Right-click menu: node, edge, and empty-canvas actions. */

import type { SpatialPresetKey } from '@kamiazya/whiteboard-canvas-render'
import {
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
  tidyNodes,
} from '@kamiazya/whiteboard-canvas-render'
import { bundledFacetRegistry, type FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type {
  CanvasColor,
  ClipboardFragment,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
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
  CopyPlus,
  ExternalLink,
  FileBox,
  Frame,
  Image as ImageIcon,
  ImageOff,
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
  SlidersHorizontal,
  Sparkles,
  SquareDashed,
  StickyNote,
  Tag,
  Trash2,
} from 'lucide-react'
import type { MutableRefObject } from 'react'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { hasClipboardFragment } from '../../lib/clipboard-store.js'
import type { BoxMove } from './align.js'
import { alignableBoxesOf, alignBoxes, distributeBoxes } from './align.js'
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js'
import type { EditorCommand } from './commands.js'
import { CREATION_LABELS } from './creation-labels.js'
import type { FileRefOption } from './DocumentPickerDialog.js'
import { nodePropertyItems } from './facet-widgets/index.js'
import { type GestureResult, type GestureState, reduceGesture } from './gestures.js'
import type { Point } from './viewport.js'

/** Open right-click menu: screen position (root-relative) + hit target. */
export interface ContextMenuTarget {
  readonly x: number
  readonly y: number
  readonly nodeId: string | undefined
  readonly edgeId: string | undefined
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
  readonly setFacetPanelNodeId: (nodeId: string | null) => void
}

export interface CanvasContextMenuProps {
  readonly commands: CanvasCommands
  readonly contextMenu: ContextMenuTarget
  readonly setContextMenu: (target: ContextMenuTarget | null) => void
  readonly canvas: SpatialCanvas
  readonly canvasRef: MutableRefObject<SpatialCanvas>
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
    setFacetPanelNodeId,
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
  return (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      variant={contextMenu.variant}
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
        const presetSwatches = (theme === 'dark' ? SPATIAL_DARK_PALETTE : SPATIAL_LIGHT_PALETTE)
          .presets
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
          // The JSON Canvas color union is presets OR a 6-digit hex;
          // the native color input covers the hex half the swatches
          // cannot.
          customColor: {
            value: current?.startsWith('#') === true ? current : '#808080',
            ariaLabel: 'Custom color',
            selected: current?.startsWith('#') === true,
            onPick: (hex: string) => apply(hex as CanvasColor),
          },
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
            { kind: 'separator' as const },
            {
              label: 'Edit label',
              icon: <Tag />,
              onSelect: () => setEdgeLabelEditId(edge.id),
            },
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
              label: CREATION_LABELS.note,
              icon: <StickyNote />,
              onSelect: () => createNodeAt(contextMenu.point),
            },
            {
              label: CREATION_LABELS.link,
              icon: <Link />,
              onSelect: () => setLinkDialog({ mode: 'create', point: contextMenu.point }),
            },
            {
              label: CREATION_LABELS.group,
              icon: <Frame />,
              onSelect: () => createGroupAtViewportCenter(contextMenu.point),
            },
          ]
          if (fileRefOptions !== undefined) {
            emptyItems.push({
              label: CREATION_LABELS.document,
              icon: <FileBox />,
              onSelect: () => setDocumentPicker({ mode: 'create', point: contextMenu.point }),
            })
          }
          if (onAddImage !== undefined) {
            emptyItems.push({
              label: CREATION_LABELS.image,
              icon: <ImageIcon />,
              onSelect: () => {
                pendingImagePointRef.current = contextMenu.point
                imageInputRef.current?.click()
              },
            })
          }
          // Tidy needs a second node to tidy AGAINST — the item appears
          // only once it can do something, like Align/Distribute above.
          if (canvas.nodes.length >= 2) {
            emptyItems.push({ kind: 'separator' })
            emptyItems.push({
              label: 'Tidy canvas',
              icon: <Sparkles />,
              onSelect: () =>
                applyBoxMoves(tidyNodes(canvasRef.current.nodes, { locked: isLocked })),
            })
          }
          return emptyItems
        }
        // The catalog's band order, shared by both vessels (list and grid):
        // 1. properties (state pickers — the menu stays open),
        // 2. verbs (one-shot — the menu closes),
        // 3. the destructive entry, alone at the bottom.
        const properties: ContextMenuItem[] = []
        const verbs: ContextMenuItem[] = []
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
                commands: [
                  { kind: 'set-group-background', id: node.id, background, backgroundStyle },
                ],
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
          colorRow(node.color, (color) => {
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
                      !isEdgeLocked(edge.id) &&
                      members.has(edge.fromNode) &&
                      members.has(edge.toNode),
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
        // Facet quick bands ride the contribution seam: this surface asks the
        // registry what the point carries and looks widgets up by key — it
        // never names a plugin or facet itself (facet-wiring-guard.test.ts
        // keeps it that way). Bands apply to the whole selection, the same
        // semantics as Color.
        {
          const applyToSelection = (
            commandsFor: (targetIds: readonly string[]) => readonly EditorCommand[],
          ) => {
            const members = new Set(selectedId !== null ? [selectedId, ...extraIds] : [])
            const nodeTargets = members.has(node.id) ? [...members] : [node.id]
            applyResult({ state: { kind: 'idle' }, commands: [...commandsFor(nodeTargets)] })
          }
          properties.push(...nodePropertyItems(facetRegistry, { node, applyToSelection }))
          // The quick bands are one tier; everything a facet declares —
          // including facets no band knows about — is reachable here.
          properties.push({
            label: 'Facets…',
            icon: <SlidersHorizontal />,
            onSelect: () => setFacetPanelNodeId(node.id),
          })
        }
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
                [
                  'horizontal',
                  'Distribute horizontally',
                  <AlignHorizontalDistributeCenter key="h" />,
                ],
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
        return [
          ...properties,
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
      })()}
    />
  )
}
