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
import type { CanvasLine } from '@kamiazya/whiteboard-model'
import { Lock as LockIcon, LockOpen, Trash2 } from 'lucide-react'
import type { EditorCommand } from '../../../lib/spatial/commands.js'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'

export interface InkMenuItemsInput {
  readonly line: CanvasLine
  readonly isEdgeLocked: (id: string) => boolean
  readonly edgeLockEnabled: boolean
  readonly onToggleEdgeLock: CanvasCommands['onToggleEdgeLock']
  readonly applyResult: (result: {
    state: { kind: 'idle' }
    commands: readonly EditorCommand[]
  }) => void
  readonly setSelectedEdgeId: (id: string | null) => void
}

export function inkMenuItems({
  line,
  isEdgeLocked,
  edgeLockEnabled,
  onToggleEdgeLock,
  applyResult,
  setSelectedEdgeId,
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
  return [
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
