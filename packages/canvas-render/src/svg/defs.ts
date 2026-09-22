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

/** The VNodes a child holds at its top level: itself, or those in its nested arrays. */
function* vnodesIn(child: SvgChild): Iterable<SvgVNode> {
  if (Array.isArray(child)) {
    for (const inner of child) yield* vnodesIn(inner)
  } else if (isVNode(child)) {
    yield child
  }
}

/** The definitions hoisted so far, in emission order, and the ids among them. */
interface Hoisted {
  readonly seen: Set<string>
  readonly collected: SvgDef[]
}

function visit(child: SvgChild, into: Hoisted): void {
  for (const node of vnodesIn(child)) {
    for (const def of node.defs ?? []) hoist(def, into)
    for (const inner of node.children ?? []) visit(inner, into)
  }
}

function hoist(def: SvgDef, into: Hoisted): void {
  if (into.seen.has(def.id)) return
  into.seen.add(def.id)
  // A definition's own node may declare the definitions IT depends on (a
  // mask carrying its gradient). Visit it before pushing so a dependency is
  // emitted ahead of its dependent; `seen` is marked first, so mutually
  // dependent definitions terminate.
  visit(def.node, into)
  into.collected.push(def)
}

export function collectDefs(children: ReadonlyArray<SvgChild>): ReadonlyArray<SvgDef> {
  const into: Hoisted = { seen: new Set(), collected: [] }
  for (const child of children) visit(child, into)
  return into.collected
}
