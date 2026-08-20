/**
 * Hoists inherited paint attributes shared by every child of a container
 * (`<g>`/`<a>`) onto the container itself — the SVG-inheritance form of
 * deduplication, measured at ~30-40% of a realistic document's raw bytes
 * (96 identical `fill font-family font-size` clusters on one 40-node
 * canvas). Pure VNode→VNode; painted output is provably unchanged (the
 * computed-paint equivalence property in hoist.test.ts).
 *
 * The soundness rule: an attribute is lifted only when EVERY direct child
 * is an element that declares it with the SAME value. A child lacking the
 * attribute blocks the lift — it would otherwise start inheriting a value
 * it never declared — and an opaque `rawXml` child blocks all lifting for
 * its container, since its computed style cannot be inspected. Nearest-
 * ancestor-wins keeps differing descendants untouched. Bottom-up
 * application lets lifts compose through nested containers.
 */

import type { SvgAttrs, SvgAttrValue, SvgChild, SvgDef, SvgVNode } from './vnode.js'

/** The SVG-inherited presentation attributes this backend emits. `role`,
 * `mask`, and `xml:space` are deliberately absent: not inheritance-safe
 * (`role`), not inherited (`mask`), or content semantics (`xml:space`). */
const HOISTABLE = [
  'fill',
  'stroke',
  'stroke-width',
  'font-family',
  'font-size',
  'fill-opacity',
  'stroke-opacity',
] as const

/** Containers legal to receive inherited paint and emitted by this backend. */
const CONTAINERS = new Set(['g', 'a'])

function isVNode(child: SvgChild): child is SvgVNode {
  return typeof child === 'object' && child !== null && 'tag' in child
}

function rebuild(
  node: SvgVNode,
  attrs: SvgAttrs | undefined,
  children: ReadonlyArray<SvgChild> | undefined,
): SvgVNode {
  const defs: { defs?: ReadonlyArray<SvgDef> } = node.defs === undefined ? {} : { defs: node.defs }
  return {
    tag: node.tag,
    ...(attrs === undefined ? {} : { attrs }),
    ...(children === undefined ? {} : { children }),
    ...defs,
  }
}

function withoutAttrs(node: SvgVNode, names: ReadonlySet<string>): SvgVNode {
  if (node.attrs === undefined || names.size === 0) return node
  const attrs = Object.fromEntries(Object.entries(node.attrs).filter(([name]) => !names.has(name)))
  return rebuild(node, attrs, node.children)
}

/** `role` stays the last attribute — the canonical position it has always
 * had on this backend's container elements. */
function withHoisted(node: SvgVNode, hoisted: ReadonlyMap<string, SvgAttrValue>): SvgVNode {
  if (hoisted.size === 0) return node
  const existing = Object.entries(node.attrs ?? {})
  const attrs: Record<string, SvgAttrValue> = Object.fromEntries(
    existing.filter(([name]) => name !== 'role'),
  )
  for (const name of HOISTABLE) {
    const value = hoisted.get(name)
    if (value !== undefined) attrs[name] = value
  }
  const role = existing.find(([name]) => name === 'role')
  if (role !== undefined) attrs.role = role[1]
  return rebuild(node, attrs, node.children)
}

function flatten(children: ReadonlyArray<SvgChild>): SvgChild[] {
  const out: SvgChild[] = []
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flatten(child))
    else out.push(child)
  }
  return out
}

type ChangeFlag = { changed: boolean }

function hoistContainer(container: SvgVNode, flag: ChangeFlag): SvgVNode {
  const children = flatten(container.children ?? [])
  const elements = children.filter(isVNode)
  // A non-element child (text, rawXml) cannot be inspected or is content —
  // lifting anything past it is unsound, so the container is left alone.
  if (elements.length === 0 || elements.length !== children.length) {
    return rebuild(container, container.attrs, children)
  }

  const lift = new Map<string, SvgAttrValue>()
  const strip = new Set<string>()
  for (const name of HOISTABLE) {
    const first = elements[0]?.attrs?.[name]
    if (first === undefined) continue
    if (!elements.every((element) => element.attrs?.[name] === first)) continue
    const own = container.attrs?.[name]
    if (own === undefined) {
      lift.set(name, first)
      strip.add(name)
    } else if (own === first) {
      // The parent already declares the same value: the copies are noise.
      strip.add(name)
    }
  }
  if (strip.size === 0) return rebuild(container, container.attrs, children)
  flag.changed = true
  return withHoisted(
    rebuild(
      container,
      container.attrs,
      children.map((child) => (isVNode(child) ? withoutAttrs(child, strip) : child)),
    ),
    lift,
  )
}

function hoistOnce(child: SvgChild, flag: ChangeFlag): SvgChild {
  if (typeof child === 'string') return child
  if (Array.isArray(child)) return child.map((inner) => hoistOnce(inner, flag))
  if (!isVNode(child)) return child
  const node =
    child.children === undefined
      ? child
      : rebuild(
          child,
          child.attrs,
          child.children.map((inner) => hoistOnce(inner, flag)),
        )
  return CONTAINERS.has(node.tag) ? hoistContainer(node, flag) : node
}

/**
 * Applies hoisting bottom-up through the whole tree, ITERATED TO A
 * FIXPOINT. One bottom-up pass is not enough: stripping a nested
 * container's attribute (because its parent lifted the same value) can
 * make that container's own children newly uniform — an opportunity the
 * pass already walked past. Verified by the shrunk counterexample
 * `g[g{sw:1}[rect{sw:2}]]`, where a single pass is not idempotent. Each
 * pass only moves attributes upward or deletes copies, so the iteration
 * terminates; in practice it converges in one or two passes.
 *
 * Nested child arrays are flattened inside processed containers —
 * byte-identical, since the serializer flattens them anyway.
 */
export function hoistInheritedAttrs(child: SvgChild): SvgChild {
  let current = child
  for (;;) {
    const flag: ChangeFlag = { changed: false }
    current = hoistOnce(current, flag)
    if (!flag.changed) return current
  }
}
