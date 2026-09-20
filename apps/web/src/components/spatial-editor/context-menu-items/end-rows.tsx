/**
 * The two option rows about an element's ENDS — arrowheads, and which side
 * of a box an end leaves from — shared by the relation menu and the ink one.
 *
 * Shared rather than copied because the choices ARE the same: a line's ends
 * carry `end` and `side` exactly as a relation's do (`lineEndSchema` against
 * `edgeEndSchema`), and two copies of a five-way picker are two chances for
 * one of them to grow a sixth. What differs is only the command each menu
 * writes, so that is what the caller supplies.
 */
import type { CanvasEdge, CanvasLine, EdgeSide } from '@kamiazya/whiteboard-model'
import { endSide } from '@kamiazya/whiteboard-model'
import { PanelBottom, PanelLeft, PanelRight, PanelTop, SquareDashed } from 'lucide-react'
import type { ContextMenuOptionsItem } from '../ContextMenu.js'

/** Arrow direction reads the JSON Canvas defaults (fromEnd none, toEnd arrow). */
const ARROW_STATES = [
  { label: '→', ariaLabel: 'Forward', fromEnd: 'none', toEnd: 'arrow' },
  { label: '↔', ariaLabel: 'Both', fromEnd: 'arrow', toEnd: 'arrow' },
  { label: '←', ariaLabel: 'Backward', fromEnd: 'arrow', toEnd: 'none' },
  { label: '−', ariaLabel: 'None', fromEnd: 'none', toEnd: 'none' },
] as const

/**
 * Excel-border-style side pickers: a rectangle with the pinned side
 * emphasised; dashed means unpinned (the router decides).
 */
const SIDES = [
  { label: 'auto', ariaLabel: 'Auto', icon: <SquareDashed />, side: undefined },
  { label: 'top', ariaLabel: 'Top', icon: <PanelTop />, side: 'top' },
  { label: 'right', ariaLabel: 'Right', icon: <PanelRight />, side: 'right' },
  { label: 'bottom', ariaLabel: 'Bottom', icon: <PanelBottom />, side: 'bottom' },
  { label: 'left', ariaLabel: 'Left', icon: <PanelLeft />, side: 'left' },
] as const

export function arrowRow(
  element: CanvasEdge | CanvasLine,
  apply: (ends: { fromEnd: 'none' | 'arrow'; toEnd: 'none' | 'arrow' }) => void,
): ContextMenuOptionsItem {
  // A RELATION points by default and ink does not: an arrow on a stroke is
  // something a person asked for, where on a relation it is the format's own
  // default (JSON Canvas `toEnd: arrow`). Reading the default per kind is
  // what keeps the row's ticked state honest for both.
  //
  // The discriminant is the ABSENCE of `kind`, which is what `endSide` and
  // `endNode` already read. Asking whether the end names a node cannot tell
  // the two apart: a line end on a box carries `node` exactly as an edge end
  // does, and the extra `kind` is the only thing that distinguishes them.
  const pointsByDefault = !('kind' in element.from)
  const fromEnd = element.from.end ?? 'none'
  const toEnd = element.to.end ?? (pointsByDefault ? 'arrow' : 'none')
  return {
    kind: 'options' as const,
    label: 'Arrows',
    options: ARROW_STATES.map((state) => ({
      label: state.label,
      ariaLabel: state.ariaLabel,
      selected: state.fromEnd === fromEnd && state.toEnd === toEnd,
      onSelect: () => apply({ fromEnd: state.fromEnd, toEnd: state.toEnd }),
    })),
  }
}

export function sideRow(
  element: CanvasEdge | CanvasLine,
  endpoint: 'from' | 'to',
  apply: (side: EdgeSide | undefined) => void,
): ContextMenuOptionsItem {
  const current = endSide(endpoint === 'from' ? element.from : element.to)
  return {
    kind: 'options' as const,
    label: endpoint === 'from' ? 'From side' : 'To side',
    options: SIDES.map((entry) => ({
      label: entry.label,
      icon: entry.icon,
      ariaLabel: entry.ariaLabel,
      selected: current === entry.side,
      onSelect: () => apply(entry.side),
    })),
  }
}

/**
 * Whether this end meets a box at all. A line's end may be a free POINT,
 * which has no side to leave from — so the row is absent rather than
 * offering five choices that write nothing.
 */
export function endMeetsNode(element: CanvasEdge | CanvasLine, endpoint: 'from' | 'to'): boolean {
  const end = endpoint === 'from' ? element.from : element.to
  return 'node' in end
}
