/**
 * Hoists the `defs` declarations scattered through a VNode tree into one
 * ordered, id-deduplicated list — the document assembly wraps the result in
 * a single `<defs>` element as the root's first child, or emits nothing
 * when the list is empty. First occurrence wins on an id collision, which
 * is sound because ids are content-derived by contract (see `SvgVNode.defs`):
 * two declarations sharing an id say the same thing in the same bytes.
 */

import type { SvgChild, SvgDef, SvgVNode } from './vnode.js'

function isVNode(child: SvgChild): child is SvgVNode {
  return typeof child === 'object' && child !== null && 'tag' in child
}

export function collectDefs(children: ReadonlyArray<SvgChild>): ReadonlyArray<SvgDef> {
  const seen = new Set<string>()
  const collected: SvgDef[] = []
  const visit = (child: SvgChild): void => {
    if (Array.isArray(child)) {
      for (const inner of child) visit(inner)
      return
    }
    if (!isVNode(child)) return
    for (const def of child.defs ?? []) {
      if (seen.has(def.id)) continue
      seen.add(def.id)
      collected.push(def)
    }
    for (const inner of child.children ?? []) visit(inner)
  }
  for (const child of children) visit(child)
  return collected
}
