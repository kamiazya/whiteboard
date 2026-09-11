import type { SpatialPalette } from '@kamiazya/whiteboard-canvas-render'
/**
 * The edge branch: the locked-edge [Unlock] short-circuit, then arrows/
 * side/color rows, label/lock/delete.
 */
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { endpointSide } from '@kamiazya/whiteboard-model'
import {
  Lock as LockIcon,
  LockOpen,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  SquareDashed,
  Tag,
  Trash2,
} from 'lucide-react'
import type { EditorCommand } from '../../../lib/spatial/commands.js'
import type { Point } from '../../../lib/spatial/viewport.js'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'
import { facetPropertyItems } from '../facet-widgets/index.js'
import { commentOnEdgeItem } from './annotation-verbs.js'
import { colorRow } from './color-row.js'

export interface EdgeMenuItemsInput {
  readonly edge: CanvasEdge
  /** Where the menu was opened, in canvas coordinates — the comment's stored point. */
  readonly point: Point
  readonly setCommentCompose: CanvasCommands['setCommentCompose']
  /** The palette the canvas is drawn in, for the colour row's swatches. */
  readonly palette: SpatialPalette
  readonly isEdgeLocked: (edgeId: string) => boolean
  readonly edgeLockEnabled: boolean
  readonly applyResult: CanvasCommands['applyResult']
  readonly setEdgeLabelEditId: CanvasCommands['setEdgeLabelEditId']
  readonly setSelectedEdgeId: CanvasCommands['setSelectedEdgeId']
  readonly onToggleEdgeLock: CanvasCommands['onToggleEdgeLock']
  /** The registry the doorway asks whether this surface carries any facets. */
  readonly facetRegistry: FacetRegistry
  readonly setFacetPanelOpen: CanvasCommands['setFacetPanelOpen']
}

export function edgeMenuItems({
  edge,
  point,
  setCommentCompose,
  palette,
  isEdgeLocked,
  edgeLockEnabled,
  applyResult,
  setEdgeLabelEditId,
  setSelectedEdgeId,
  onToggleEdgeLock,
  facetRegistry,
  setFacetPanelOpen,
}: EdgeMenuItemsInput): ContextMenuItem[] {
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
  const fromEnd = edge.from.end ?? 'none'
  const toEnd = edge.to.end ?? 'arrow'
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
    const current = endpointSide(endpoint === 'from' ? edge.from : edge.to)
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
    colorRow(palette, edge.color, (color) =>
      applyEdgeCommand({ kind: 'set-edge-color', id: edge.id, color }),
    ),
    // Facets reach this surface the same ONE way they reach the node menu:
    // a doorway to the inspector, never rows of values — an action menu runs
    // an entry and closes, and a facet is state you adjust repeatedly. It
    // sits after the property rows and before the actions, so the menu reads
    // properties, then facets, then verbs. This menu names no plugin and no
    // facet key (facet-wiring-guard.test.ts keeps it so).
    ...facetPropertyItems(facetRegistry, 'inspector.edge', {
      // Selecting is part of opening: the inspector is ABOUT the selection,
      // and a right-click opens this menu without selecting, so a doorway
      // that only raised the flag would show a panel about nothing.
      openPanel: () => {
        setSelectedEdgeId(edge.id)
        setFacetPanelOpen(true)
      },
    }),
    { kind: 'separator' as const },
    {
      label: 'Edit label',
      icon: <Tag />,
      onSelect: () => setEdgeLabelEditId(edge.id),
    },
    commentOnEdgeItem(edge, point, setCommentCompose),
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
