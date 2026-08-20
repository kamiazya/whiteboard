/**
 * Shared fast-check arbitraries over SVG VNode trees, for properties that
 * must hold for EVERY registered optimization pass (svg/transform.ts) as
 * well as for pass-specific oracles (svg/hoist.test.ts). Trees are built
 * as plain literals (not `el`) so generators can compose arbitrary attr
 * combinations without satisfying the per-element table.
 */

import type { SvgAttrs, SvgChild, SvgVNode } from '../svg/vnode.js'
import { fc } from './fast-check.js'

export const vnode = (tag: string, attrs?: SvgAttrs, children?: readonly SvgChild[]): SvgVNode => ({
  tag,
  ...(attrs === undefined ? {} : { attrs }),
  ...(children === undefined ? {} : { children }),
})

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
  paintArb.map((paint) => vnode('text', { x: 0, y: 0, ...paint }, ['t'])),
  paintArb.map((paint) => vnode('rect', { x: 0, y: 0, width: 1, height: 1, ...paint })),
)

/**
 * A paint-attribute-bearing element tree with `g`/`a` containers — dense
 * enough that hoisting opportunities (every-child-same-value) actually
 * arise, which is what its mutation checks rely on.
 */
export const svgPaintTreeArb: fc.Arbitrary<SvgVNode> = fc.letrec<{ tree: SvgVNode }>((tie) => ({
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
        vnode(tag, { ...paint, ...(role === undefined ? {} : { role }) }, children),
      ),
  ),
})).tree
