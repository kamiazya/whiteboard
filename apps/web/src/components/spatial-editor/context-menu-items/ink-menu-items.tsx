/**
 * The ink branch: what a drawn LINE can be told to do.
 *
 * Its own branch rather than the edge's, because most of what an edge's menu
 * offers is about a relation between two boxes — which side it leaves, which
 * end carries an arrowhead, what its label says — and a stroke has none of
 * that. What is left is what a person actually wants from a scribble.
 *
 * It exists at all because Delete used to be reachable only from the
 * keyboard: the menu resolved its target out of `canvas.edges`, where a line
 * is not, so a press on ink opened the empty-canvas menu. On a phone that
 * left no way to remove a stroke at all.
 */
import type { SpatialPalette } from '@kamiazya/whiteboard-canvas-render'
import type { CanvasColor, CanvasLine } from '@kamiazya/whiteboard-model'
import { resolveInkGroup } from '@kamiazya/whiteboard-plugin-visual'
import { Lock as LockIcon, LockOpen, Tag, Trash2, Ungroup } from 'lucide-react'
import type { EditorCommand } from '../../../lib/spatial/commands.js'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'
import { colorRow } from './color-row.js'

export interface InkMenuItemsInput {
  readonly line: CanvasLine
  /** Every stroke on the board, for finding the rest of this one's mark. */
  readonly lines: readonly CanvasLine[]
  /** The palette the BOARD is drawn in, so a swatch shows the ink a pick produces. */
  readonly palette: SpatialPalette
  readonly isEdgeLocked: (id: string) => boolean
  readonly edgeLockEnabled: boolean
  readonly onToggleEdgeLock: CanvasCommands['onToggleEdgeLock']
  readonly applyResult: (result: {
    state: { kind: 'idle' }
    commands: readonly EditorCommand[]
  }) => void
  readonly setSelectedEdgeId: (id: string | null) => void
  /** Opens the in-place label editor on this stroke. */
  readonly setEdgeLabelEditId: (id: string | null) => void
}

export function inkMenuItems({
  line,
  lines,
  palette,
  isEdgeLocked,
  edgeLockEnabled,
  onToggleEdgeLock,
  applyResult,
  setSelectedEdgeId,
  setEdgeLabelEditId,
}: InkMenuItemsInput): ContextMenuItem[] {
  // Locked ink offers exactly one action, the same contract the edge branch
  // keeps: everything else here is a mutation the lock exists to refuse.
  if (isEdgeLocked(line.id)) {
    return [
      {
        label: 'Unlock',
        icon: <LockOpen />,
        onSelect: () => onToggleEdgeLock?.(line.id, false),
      },
    ]
  }
  // Strokes written one after another are joined into a mark automatically,
  // so there has to be a way to say the guess was wrong. Offered only when
  // there IS a mark to break: a lone stroke has nothing to ungroup, and a
  // verb that does nothing is worse than an absent one.
  const group = resolveInkGroup(line)
  const mates = group === undefined ? [] : lines.filter((entry) => resolveInkGroup(entry) === group)
  const recolour = (color: CanvasColor | undefined) =>
    applyResult({
      state: { kind: 'idle' },
      // The whole MARK, not the one stroke pressed — the same unit every
      // other verb on this menu acts on, and the same unit a press selects.
      // A handwritten character recoloured one stroke at a time is a
      // character in two colours.
      commands: (mates.length > 1 ? mates : [line]).map(
        (entry) => ({ kind: 'set-line-color', id: entry.id, color }) as const,
      ),
    })
  return [
    colorRow(palette, line.color, recolour),
    { kind: 'separator' as const },
    ...(mates.length > 1
      ? [
          {
            label: 'Ungroup' as const,
            icon: <Ungroup />,
            onSelect: () => {
              applyResult({
                state: { kind: 'idle' },
                commands: [{ kind: 'ungroup-ink', ids: mates.map((entry) => entry.id) } as const],
              })
              setSelectedEdgeId(line.id)
            },
          },
          { kind: 'separator' as const },
        ]
      : []),
    {
      // A stroke can carry a name, and the renderer has drawn one all along
      // (`composeEdgeLabel` takes a relation or a line). The double press
      // already opened this editor; the menu is the device with no keyboard
      // and no double press to spare.
      label: 'Edit label',
      icon: <Tag />,
      onSelect: () => setEdgeLabelEditId(line.id),
    },
    { kind: 'separator' as const },
    ...(edgeLockEnabled
      ? [
          {
            label: 'Lock' as const,
            icon: <LockIcon />,
            onSelect: () => {
              onToggleEdgeLock?.(line.id, true)
              setSelectedEdgeId(null)
            },
          },
          { kind: 'separator' as const },
        ]
      : []),
    {
      label: 'Delete',
      icon: <Trash2 />,
      danger: true,
      onSelect: () => {
        applyResult({
          state: { kind: 'idle' },
          commands: [{ kind: 'delete-line', id: line.id } as const],
        })
        setSelectedEdgeId(null)
      },
    },
  ]
}
