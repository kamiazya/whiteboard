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
import { resolveInkGroup, VISUAL_INK_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { Group, Lock as LockIcon, LockOpen, Tag, Trash2, Ungroup } from 'lucide-react'
import type { EditorCommand } from '../../../lib/spatial/commands.js'
import type { CanvasCommands } from '../CanvasContextMenu.js'
import type { ContextMenuItem } from '../ContextMenu.js'
import { colorRow } from './color-row.js'
import { arrowRow, endMeetsNode, sideRow } from './end-rows.js'

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
  /**
   * Every selected stroke or relation, which is what Group and Delete act on
   * — the pressed line alone can never be a mark.
   */
  readonly selectedInkIds: readonly string[]
  /**
   * The removal for one selected id, whichever collection holds it.
   *
   * A selection carries ink ids without knowing whether each came from
   * `edges` or `lines`, so exactly one place looks — `deleteInkCommand`, the
   * same one the Delete KEY goes through. Passed in rather than resolved
   * here because this menu is handed the strokes and never the relations.
   */
  readonly deleteInk: (id: string) => EditorCommand | undefined
  /** Mints the group id, so the menu invents no identity of its own. */
  readonly createId: () => string
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
  selectedInkIds,
  createId,
  deleteInk,
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
  // The strokes a Group would join: what is selected, narrowed to ink this
  // canvas actually holds. Offered only when there are two or more — a mark
  // of one is what carrying no group already means, and a verb that does
  // nothing is worse than an absent one (the rule Ungroup already follows).
  const byId = new Map(lines.map((entry) => [entry.id, entry]))
  const joinable = selectedInkIds.flatMap((id) => {
    const entry = byId.get(id)
    return entry === undefined ? [] : [entry]
  })
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
  const write = (command: EditorCommand) =>
    applyResult({ state: { kind: 'idle' }, commands: [command] })
  return [
    colorRow(palette, line.color, recolour),
    // A stroke's ends carry an arrowhead and a side exactly as a relation's
    // do, and the rows are the relation menu's own — shared rather than
    // copied, so the two cannot grow apart. The SIDE row is offered per end
    // and only where that end meets a box: a free end has no side to pin,
    // and five choices that write nothing is worse than an absent row.
    arrowRow(line, (ends) => write({ kind: 'set-line-ends', id: line.id, ...ends })),
    ...(['from', 'to'] as const).flatMap((endpoint) =>
      endMeetsNode(line, endpoint)
        ? [
            sideRow(line, endpoint, (side) =>
              write({ kind: 'set-line-side', id: line.id, endpoint, side }),
            ),
          ]
        : [],
    ),
    { kind: 'separator' as const },
    ...(joinable.length > 1
      ? [
          {
            label: 'Group' as const,
            icon: <Group />,
            onSelect: () => {
              // ONE fresh id for the whole set, minted by the editor's
              // factory rather than here: a mark is an identity, and two
              // strokes given two ids are two marks that look like one.
              // Strokes already in other marks are absorbed, which is what
              // makes this the real inverse of Ungroup rather than a verb
              // that only works on loose ink.
              const id = createId()
              applyResult({
                state: { kind: 'idle' },
                commands: joinable.map(
                  (entry) =>
                    ({
                      kind: 'set-line-facet',
                      id: entry.id,
                      key: VISUAL_INK_KEY,
                      payload: { group: id },
                    }) as const,
                ),
              })
            },
          },
          { kind: 'separator' as const },
        ]
      : []),
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
        // The whole SELECTION, which is what the Delete key already takes.
        // The two agreed only by accident before: a right-click collapsed
        // the ink selection to the pressed stroke, so "the selection" and
        // "this stroke" were the same thing. Now that a press on a member
        // keeps the set, a menu Delete that took one would be the odd one
        // out — and would read as the menu losing the rest.
        //
        // Resolved through `deleteInk` rather than the stroke list beside
        // it: a marquee band fills the selection from BOTH collections, so
        // a Delete that only knew the strokes left the banded relations
        // standing while the Delete key took them.
        const targets = selectedInkIds.length > 1 ? selectedInkIds : [line.id]
        applyResult({
          state: { kind: 'idle' },
          commands: targets.flatMap((id) => deleteInk(id) ?? []),
        })
        setSelectedEdgeId(null)
      },
    },
  ]
}
