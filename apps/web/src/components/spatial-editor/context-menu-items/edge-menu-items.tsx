/**
 * The edge branch: the locked-edge [Unlock] short-circuit, then arrows/
 * side/color rows, label/lock/delete.
 */
import type { CanvasEdge } from '@kamiazya/whiteboard-model'
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
import type { ResolvedTheme } from '../../../lib/theme.js'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'
import type { EditorCommand } from '../commands.js'
import { colorRow } from './color-row.js'

export interface EdgeMenuItemsInput {
  readonly edge: CanvasEdge
  readonly theme: ResolvedTheme
  readonly isEdgeLocked: (edgeId: string) => boolean
  readonly edgeLockEnabled: boolean
  readonly applyResult: CanvasCommands['applyResult']
  readonly setEdgeLabelEditId: CanvasCommands['setEdgeLabelEditId']
  readonly setSelectedEdgeId: CanvasCommands['setSelectedEdgeId']
  readonly onToggleEdgeLock: CanvasCommands['onToggleEdgeLock']
}

export function edgeMenuItems({
  edge,
  theme,
  isEdgeLocked,
  edgeLockEnabled,
  applyResult,
  setEdgeLabelEditId,
  setSelectedEdgeId,
  onToggleEdgeLock,
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
    colorRow(theme, edge.color, (color) =>
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
