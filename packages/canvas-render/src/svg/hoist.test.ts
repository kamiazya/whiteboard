import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
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

const paintArb = fc.record(
  {
    fill: fc.constantFrom('#111111', '#404040'),
    'font-family': fc.constantFrom('Roboto', 'serif'),
    'font-size': fc.constantFrom(14, 16),
    'stroke-width': fc.constantFrom(1, 2),
  },
  { requiredKeys: [] },
)

const leafArb: fc.Arbitrary<SvgVNode> = fc.oneof(
  paintArb.map((paint) => node('text', { x: 0, y: 0, ...paint }, ['t'])),
  paintArb.map((paint) => node('rect', { x: 0, y: 0, width: 1, height: 1, ...paint })),
)

const treeArb: fc.Arbitrary<SvgVNode> = fc.letrec<{ tree: SvgVNode }>((tie) => ({
  tree: fc.oneof(
    { maxDepth: 3, withCrossShrink: true },
    leafArb,
    fc
      .tuple(
        fc.constantFrom('g', 'a'),
        paintArb,
        fc.option(fc.constant('presentation' as const), { nil: undefined }),
        fc.array(tie('tree'), { maxLength: 4 }),
      )
      .map(([tag, paint, role, children]) =>
        node(tag, { ...paint, ...(role === undefined ? {} : { role }) }, children),
      ),
  ),
})).tree

describe('hoistInheritedAttrs (PBT)', () => {
  fcTest.prop([treeArb], withDefaults())(
    'preserves every element sequence, computed paint, and non-paint attrs',
    (tree) => {
      const before: Resolved[] = []
      const after: Resolved[] = []
      resolvePaint(tree, {}, before)
      resolvePaint(hoistInheritedAttrs(tree), {}, after)
      expect(after).toEqual(before)
    },
  )

  fcTest.prop([treeArb], withDefaults())('is idempotent', (tree) => {
    const once = hoistInheritedAttrs(tree)
    expect(hoistInheritedAttrs(once)).toEqual(once)
  })
})
