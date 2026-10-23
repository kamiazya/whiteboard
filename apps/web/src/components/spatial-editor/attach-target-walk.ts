import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { readingOrder } from '../../lib/spatial/reading-order.js'

const ATTACH_TARGET_PREFIX = 'connect-target-'

/** The node id a rendered attach target stands for. */
const targetIdOf = (el: Element): string =>
  el.getAttribute('data-testid')?.slice(ATTACH_TARGET_PREFIX.length) ?? ''

/** Whether the element is one of the focusable attach targets. */
export const isAttachTarget = (el: Element): boolean =>
  el.getAttribute('data-testid')?.startsWith(ATTACH_TARGET_PREFIX) === true

/**
 * The attach target one step from `from` in reading order, wrapping; from
 * anywhere that is not a target a forward step lands on the first and a
 * backward step on the last.
 */
export function stepAttachTarget(
  root: Element,
  nodes: readonly SpatialNode[],
  from: Element,
  step: 1 | -1,
): { readonly element: SVGElement; readonly node: SpatialNode } | undefined {
  const order = new Map(readingOrder(nodes).map((n, i) => [n.id, i]))
  const targets = Array.from(
    root.querySelectorAll<SVGElement>(`[data-testid^="${ATTACH_TARGET_PREFIX}"]`),
  ).sort((a, b) => (order.get(targetIdOf(a)) ?? 0) - (order.get(targetIdOf(b)) ?? 0))
  const at = targets.findIndex((t) => t === from)
  const index =
    at < 0 ? (step > 0 ? 0 : targets.length - 1) : (at + step + targets.length) % targets.length
  const element = targets[index]
  const node = nodes.find((n) => n.id === (element === undefined ? '' : targetIdOf(element)))
  return element === undefined || node === undefined ? undefined : { element, node }
}
