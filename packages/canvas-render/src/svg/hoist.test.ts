import { describe, expect, it } from 'vitest'
import { fcTest, withDefaults } from '../test-utils/fast-check.js'
import { svgPaintTreeArb } from '../test-utils/svg-vnode-arbitraries.js'
import { hoistInheritedAttrs } from './hoist.js'
import { serializeSvg } from './serialize.js'
import type { SvgAttrs, SvgAttrValue, SvgChild, SvgVNode } from './vnode.js'
import { rawXml } from './vnode.js'

// Built as plain literals (not `el`) so tests and generators can compose
// arbitrary attr combinations without satisfying the per-element table.
const node = (tag: string, attrs?: SvgAttrs, children?: readonly SvgChild[]): SvgVNode => ({
  tag,
  ...(attrs === undefined ? {} : { attrs }),
  ...(children === undefined ? {} : { children }),
})

const asSvg = (child: SvgChild): string => serializeSvg(node('svg', undefined, [child]))

describe('hoistInheritedAttrs', () => {
  it('hoists paint attrs shared by every direct child onto the group, in canonical order', () => {
    const g = node('g', undefined, [
      node('text', { x: 0, y: 0, fill: '#404040', 'font-family': 'Roboto', 'font-size': 16 }, [
        'a',
      ]),
      node('text', { x: 0, y: 20, fill: '#404040', 'font-family': 'Roboto', 'font-size': 16 }, [
        'b',
      ]),
    ])
    expect(asSvg(hoistInheritedAttrs(g))).toBe(
      '<svg><g fill="#404040" font-family="Roboto" font-size="16"><text x="0" y="0">a</text><text x="0" y="20">b</text></g></svg>',
    )
  })

  it('does not hoist an attr some child lacks — that child would start inheriting it', () => {
    const g = node('g', undefined, [
      node('text', { x: 0, y: 0, fill: '#404040' }, ['a']),
      node('rect', { x: 0, y: 0, width: 1, height: 1 }),
    ])
    expect(asSvg(hoistInheritedAttrs(g))).toBe(asSvg(g))
  })

  it('does not hoist when values differ', () => {
    const g = node('g', undefined, [
      node('text', { x: 0, y: 0, fill: '#111111' }, ['a']),
      node('text', { x: 0, y: 20, fill: '#222222' }, ['b']),
    ])
    expect(asSvg(hoistInheritedAttrs(g))).toBe(asSvg(g))
  })

  it('keeps role as the last attribute on the receiving group', () => {
    const g = node('g', { role: 'presentation' }, [
      node('text', { x: 0, y: 0, fill: '#404040' }, ['a']),
      node('text', { x: 0, y: 20, fill: '#404040' }, ['b']),
    ])
    expect(asSvg(hoistInheritedAttrs(g))).toBe(
      '<svg><g fill="#404040" role="presentation"><text x="0" y="0">a</text><text x="0" y="20">b</text></g></svg>',
    )
  })

  it('strips children matching a value the parent already declares, and leaves a differing parent value alone', () => {
    const matching = node('g', { fill: '#404040' }, [
      node('text', { x: 0, y: 0, fill: '#404040' }, ['a']),
    ])
    expect(asSvg(hoistInheritedAttrs(matching))).toBe(
      '<svg><g fill="#404040"><text x="0" y="0">a</text></g></svg>',
    )
    const differing = node('g', { fill: '#111111' }, [
      node('text', { x: 0, y: 0, fill: '#404040' }, ['a']),
    ])
    expect(asSvg(hoistInheritedAttrs(differing))).toBe(asSvg(differing))
  })

  it('composes bottom-up through nested containers (a inside g)', () => {
    const g = node('g', undefined, [
      node('a', { href: '#x' }, [node('text', { x: 0, y: 0, fill: '#404040' }, ['a'])]),
      node('text', { x: 0, y: 20, fill: '#404040' }, ['b']),
    ])
    expect(asSvg(hoistInheritedAttrs(g))).toBe(
      '<svg><g fill="#404040"><a href="#x"><text x="0" y="0">a</text></a><text x="0" y="20">b</text></g></svg>',
    )
  })

  it('a rawXml child blocks hoisting — its computed style cannot be inspected', () => {
    const g = node('g', undefined, [
      node('text', { x: 0, y: 0, fill: '#404040' }, ['a']),
      rawXml('<circle r="1"/>'),
    ])
    expect(asSvg(hoistInheritedAttrs(g))).toBe(asSvg(g))
  })

  it('keeps the container attrs it is NOT lifting, rather than blanking them', () => {
    // The receiving container declares `fill` itself while the lift is about
    // `stroke-width`. Writing every hoistable name unconditionally sets the
    // ones that were not lifted to `undefined` — which overwrites the
    // container's OWN value and silently drops it from the document.
    const tree = node('g', { fill: '#111' }, [
      node('rect', { 'stroke-width': 2 }),
      node('rect', { 'stroke-width': 2 }),
    ])

    expect(asSvg(hoistInheritedAttrs(tree))).toBe(
      '<svg><g fill="#111" stroke-width="2"><rect/><rect/></g></svg>',
    )
  })

  it('iterates to a fixpoint — one bottom-up pass leaves work behind', () => {
    // `g[g{sw:1}[rect{sw:2}]]`, the shrunk counterexample this module's own
    // docstring names. It was found by a property, fixed, and never pinned as
    // an example — and the generator has since stopped reaching it, so the
    // loop could be cut to a single pass with everything green. Pass one lifts
    // the inner group's `stroke-width` to the outer group; only pass two sees
    // that the inner group is now free to take its child's.
    const tree = node('g', undefined, [
      node('g', { 'stroke-width': 1 }, [node('rect', { 'stroke-width': 2 })]),
    ])

    expect(asSvg(hoistInheritedAttrs(tree))).toBe(
      '<svg><g stroke-width="1"><g stroke-width="2"><rect/></g></g></svg>',
    )
  })

  it('a plain TEXT child blocks hoisting, exactly as a rawXml child does', () => {
    // The soundness rule is about every direct child being an inspectable
    // element. `rawXml` is covered above; a bare string was not, and it is the
    // input that tells the element test from a test that accepts anything —
    // an opaque child that happens to be an object blocks lifting for a second
    // reason (it declares no attrs), so it cannot distinguish them.
    const tree = node('g', undefined, [node('rect', { fill: '#111' }), 'raw text'])

    expect(asSvg(hoistInheritedAttrs(tree))).toBe('<svg><g><rect fill="#111"/>raw text</g></svg>')
  })

  it.each([
    ['first', [node('rect'), node('rect', { fill: '#111' })], '<rect/><rect fill="#111"/>'],
    ['later', [node('rect', { fill: '#111' }), node('rect')], '<rect fill="#111"/><rect/>'],
  ])('handles a %s child element carrying NO attributes at all', (_where, children, inner) => {
    // Every generated leaf carries at least `x`/`y`, so nothing reached the
    // optional access on a child's `attrs` — and without it, reading one
    // throws and the whole render fails rather than declining to hoist.
    //
    // Both positions, because they exercise different reads. An attr-less
    // FIRST child makes the candidate value undefined and the rule bails
    // before ever looking at the others; only a LATER one reaches the
    // every-child comparison. The properties do reach the second case now
    // that the generator emits attr-less leaves, but only on some draws —
    // which is a mutant that dies in one run and lives in the next.
    expect(asSvg(hoistInheritedAttrs(node('g', undefined, children)))).toBe(
      `<svg><g>${inner}</g></svg>`,
    )
  })

  it('handles a container with no children key at all', () => {
    const tree = node('g', { fill: '#111' })

    expect(asSvg(hoistInheritedAttrs(tree))).toBe('<svg><g fill="#111"></g></svg>')
  })

  it('recurses INTO a nested child array, not merely past it', () => {
    // An array of plain elements cannot tell the two apart: the container
    // flattens its children anyway, so they get processed either way. It takes
    // a CONTAINER inside the array — one whose own children are hoistable — to
    // show the difference. Measured without the recursion: the inner group is
    // never visited and its two identical fills stay on the rects.
    const tree = node('g', undefined, [
      [node('g', undefined, [node('rect', { fill: '#111' }), node('rect', { fill: '#111' })])],
    ])

    expect(asSvg(hoistInheritedAttrs(tree))).toBe(
      '<svg><g fill="#111"><g><rect/><rect/></g></g></svg>',
    )
  })

  it('preserves defs declarations on rebuilt nodes', () => {
    const def = { id: 'd', node: node('mask', { id: 'd' }) }
    const g = node('g', undefined, [
      { ...node('text', { x: 0, y: 0, fill: '#404040' }, ['a']), defs: [def] },
      node('text', { x: 0, y: 20, fill: '#404040' }, ['b']),
    ])
    const hoisted = hoistInheritedAttrs(g) as SvgVNode
    const [first] = hoisted.children ?? []
    expect((first as SvgVNode).defs).toEqual([def])
  })
})

// --- property: hoisting never changes any element's computed paint ---

const HOISTABLE = [
  'fill',
  'stroke',
  'stroke-width',
  'font-family',
  'font-size',
  'fill-opacity',
  'stroke-opacity',
] as const

type Resolved = {
  readonly tag: string
  /** Computed paint — recorded only for PAINTING elements. A container's
   * own computed paint legitimately changes when it receives a hoisted
   * attribute (a `g`/`a` paints nothing itself); what must be invariant is
   * what its descendants resolve to. */
  readonly paint: Readonly<Record<string, SvgAttrValue>> | undefined
  readonly rest: Readonly<Record<string, SvgAttrValue>>
  readonly text: string
}

const CONTAINER_TAGS = new Set(['g', 'a'])

/** Independent oracle: expands inheritance the way SVG does (nearest ancestor wins). */
function resolvePaint(
  child: SvgChild,
  inherited: Readonly<Record<string, SvgAttrValue>>,
  out: Resolved[],
): void {
  if (typeof child === 'string') return
  // Array.isArray does not narrow a readonly-array union member away in its
  // false branch, so the element case needs its own guard.
  if (Array.isArray(child)) {
    for (const inner of child as ReadonlyArray<SvgChild>) resolvePaint(inner, inherited, out)
    return
  }
  if (!('tag' in child)) return
  const attrs = child.attrs ?? {}
  const paint: Record<string, SvgAttrValue> = { ...inherited }
  const rest: Record<string, SvgAttrValue> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    if ((HOISTABLE as readonly string[]).includes(key)) paint[key] = value
    else rest[key] = value
  }
  const text = (child.children ?? []).filter((c): c is string => typeof c === 'string').join('')
  out.push({ tag: child.tag, paint: CONTAINER_TAGS.has(child.tag) ? undefined : paint, rest, text })
  for (const inner of child.children ?? []) resolvePaint(inner, paint, out)
}

describe('hoistInheritedAttrs (PBT)', () => {
  fcTest.prop([svgPaintTreeArb], withDefaults())(
    'preserves every element sequence, computed paint, and non-paint attrs',
    (tree) => {
      const before: Resolved[] = []
      const after: Resolved[] = []
      resolvePaint(tree, {}, before)
      resolvePaint(hoistInheritedAttrs(tree), {}, after)
      expect(after).toEqual(before)
    },
  )

  fcTest.prop([svgPaintTreeArb], withDefaults())('is idempotent', (tree) => {
    const once = hoistInheritedAttrs(tree)
    expect(hoistInheritedAttrs(once)).toEqual(once)
  })
})
