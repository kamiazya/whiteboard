import { tidyBoxes, tidyNodes } from '@kamiazya/whiteboard-canvas-render'
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
  Sparkles,
} from 'lucide-react'
import type { MutableRefObject } from 'react'
import { announceOnCanvas } from '../../../lib/canvas-announcer.js'
import type { ContextMenuItem } from '../../ui/ContextMenu.js'
import { alignableBoxesOf, alignBoxes, distributeBoxes } from '../align.js'
import type { CanvasCommands } from '../canvas-commands.js'

const ALIGN_PHRASE = {
  left: 'left',
  'center-x': 'to horizontal centre',
  right: 'right',
  top: 'top',
  'center-y': 'to vertical centre',
  bottom: 'bottom',
} as const

export interface ArrangeBandsInput {
  readonly node: SpatialNode
  readonly canvasRef: MutableRefObject<SpatialCanvas>
  readonly isLocked: (nodeId: string) => boolean
  readonly extraIds: ReadonlySet<string>
  readonly selectedId: string | null
  readonly applyBoxMoves: CanvasCommands['applyBoxMoves']
  /** Closes the menu so the arranged result is in view. */
  readonly close: () => void
}

// Read from canvasRef (not the `canvas` prop) so a menu action never
// computes against a stale render closure.
const selectedBoxes = (input: ArrangeBandsInput) =>
  alignableBoxesOf(
    input.canvasRef.current.nodes,
    input.selectedId === null ? [] : [input.selectedId, ...input.extraIds],
  )

function alignRow(input: ArrangeBandsInput, count: number): ContextMenuItem {
  return {
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
      onSelect: () => {
        input.applyBoxMoves(alignBoxes(selectedBoxes(input), mode))
        input.close()
        announceOnCanvas(`Aligned ${count} nodes ${ALIGN_PHRASE[mode]}`)
      },
    })),
  }
}

function distributeRow(input: ArrangeBandsInput): ContextMenuItem {
  return {
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
      onSelect: () => {
        input.applyBoxMoves(distributeBoxes(selectedBoxes(input), axis))
        input.close()
        announceOnCanvas(`Distributed ${axis}ly`)
      },
    })),
  }
}

function tidyVerb(input: ArrangeBandsInput): ContextMenuItem {
  const { node, canvasRef, isLocked, extraIds, applyBoxMoves } = input
  return {
    label: 'Tidy',
    icon: <Sparkles />,
    onSelect: () => {
      applyBoxMoves(
        tidyNodes(tidyBoxes(canvasRef.current.nodes), {
          scope: new Set([node.id, ...extraIds]),
          locked: isLocked,
          edges: canvasRef.current.edges,
        }),
      )
      announceOnCanvas('Tidied')
    },
  }
}

/**
 * Align, Distribute and Tidy for a multi-node selection. Each changes the
 * board, so each closes the menu to show the result (Tidy is an action row,
 * which closes itself) and says what it did to the canvas's live region —
 * the menu is gone by the time it could.
 *
 * Align needs a second box to align TO, and distribute needs a middle one to
 * place, so each row appears only once its action means something, rather
 * than sitting there inert.
 */
export function pushArrangeBands(
  properties: ContextMenuItem[],
  verbs: ContextMenuItem[],
  input: ArrangeBandsInput,
): void {
  const count = input.extraIds.size + 1
  if (count >= 2) properties.push(alignRow(input, count))
  if (count >= 3) properties.push(distributeRow(input))
  if (count >= 2) verbs.push(tidyVerb(input))
}
