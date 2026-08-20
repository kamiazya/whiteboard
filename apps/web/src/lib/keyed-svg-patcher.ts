/**
 * Mount-once, patch-forever consumer of canvas-render's keyed SVG
 * projection. The first render lands as one innerHTML write; every later
 * render is a keyed reconciliation that touches only the groups whose
 * serialized bytes changed — string equality IS change detection, because
 * the producer's serializer is canonical and deterministic.
 *
 * Every byte that reaches the DOM is serializer-produced (the group
 * strings themselves): this layer decides only WHICH elements to replace,
 * never how markup is spelled, so canvas-render stays the single producer
 * the `dangerouslySetInnerHTML` safety argument rests on. What patching
 * buys over innerHTML replacement is DOM continuity for the 94-99% of
 * groups a typical edit leaves byte-identical (the scene-diff scoreboard's
 * measured reuse ceiling): selection, focus, running CSS animations and
 * decoded images on untouched groups survive an update.
 */

import type { KeyedSvgRender } from '@kamiazya/whiteboard-canvas-render'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface KeyedSvgPatcher {
  /** The mounted `<svg>` root — stable for the patcher's whole lifetime. */
  readonly root: SVGSVGElement
  update(next: KeyedSvgRender): void
}

/** Parses one group's serialized bytes into its single element. */
function parseGroup(svg: string): Element {
  const host = document.createElementNS(SVG_NS, 'svg')
  host.innerHTML = svg
  const element = host.firstElementChild
  if (element === null) {
    // A group is one element by the producer's contract; an empty parse
    // means the contract broke upstream, which must not fail silently.
    throw new Error('keyed svg group parsed to no element')
  }
  return element
}

export function mountKeyedSvg(container: Element, initial: KeyedSvgRender): KeyedSvgPatcher {
  container.innerHTML = initial.svg
  const root = container.firstElementChild
  if (!(root instanceof SVGSVGElement)) {
    throw new Error('keyed svg document parsed to no <svg> root')
  }

  // The mounted document's children correspond 1:1, in order, to
  // `groups` — the producer pins `svg === rootOpen + groups + close`.
  let prev = initial
  const elements = new Map<string, Element>()
  initial.groups.forEach((group, index) => {
    const child = root.children[index]
    if (child !== undefined) elements.set(group.key, child)
  })

  const update = (next: KeyedSvgRender): void => {
    // Root envelope: attribute maps are compared, not order — DOM
    // attribute order is not semantically meaningful, and setAttribute
    // keeps the existing position on value changes.
    for (const [name, value] of Object.entries(next.rootAttrs)) {
      if (prev.rootAttrs[name] !== value) root.setAttribute(name, value)
    }
    for (const name of Object.keys(prev.rootAttrs)) {
      if (!(name in next.rootAttrs)) root.removeAttribute(name)
    }

    const prevSvgByKey = new Map(prev.groups.map((group) => [group.key, group.svg]))
    const nextElements = new Map<string, Element>()
    next.groups.forEach((group, index) => {
      const existing = elements.get(group.key)
      const element =
        existing !== undefined && prevSvgByKey.get(group.key) === group.svg
          ? existing
          : parseGroup(group.svg)
      nextElements.set(group.key, element)
      // Anchor by position: insertBefore both inserts new elements and
      // moves reused ones; a replaced key's stale element drifts toward
      // the tail and is dropped by the cleanup below.
      const anchor = root.children[index] ?? null
      if (anchor !== element) root.insertBefore(element, anchor)
    })

    while (root.children.length > next.groups.length) {
      root.children[next.groups.length]?.remove()
    }

    elements.clear()
    for (const [key, element] of nextElements) elements.set(key, element)
    prev = next
  }

  return { root, update }
}
