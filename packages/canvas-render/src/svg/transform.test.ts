import { describe, expect, it } from 'vitest'
import { fcTest, withDefaults } from '../test-utils/fast-check.js'
import { svgPaintTreeArb, vnode } from '../test-utils/svg-vnode-arbitraries.js'
import { hoistInheritedAttrs } from './hoist.js'
import { serializeSvg } from './serialize.js'
import { applyOptimizationPasses, OPTIMIZATION_PASSES, type SvgNodeTransform } from './transform.js'
import type { SvgChild } from './vnode.js'

describe('the optimization pass list', () => {
  it('registers exactly the declared passes, in order', () => {
    // Adding a pass is meant to be a visible one-entry diff HERE, alongside
    // its own equivalence test — this pin is what makes an unregistered or
    // silently reordered pass loud.
    expect(OPTIMIZATION_PASSES).toEqual([hoistInheritedAttrs])
  })

  it('composes passes left-to-right in declared order', () => {
    const appendAttr =
      (name: string): SvgNodeTransform =>
      (child) =>
        typeof child === 'object' && 'tag' in child
          ? { ...child, attrs: { ...child.attrs, [name]: Object.keys(child.attrs ?? {}).length } }
          : child
    // Pass order is observable: the second pass sees the first's output.
    // With `first` applied first, `second` records 1 prior attr; reversed,
    // `first` would record 1 instead.
    const out = applyOptimizationPasses(vnode('g'), [
      appendAttr('data-first'),
      appendAttr('data-second'),
    ])
    expect(out).toEqual(vnode('g', { 'data-first': 0, 'data-second': 1 }))
  })
})

describe('every registered pass honours the shared contract', () => {
  // Render-equivalence is pass-specific (each pass ships its own oracle,
  // e.g. hoist.test.ts's inheritance expansion); what is generic is that a
  // pass must be deterministic, idempotent, total, and serializable — the
  // properties the byte-identical guarantee and the keyed diff layer
  // (string equality as change detection) rest on.
  for (const [index, pass] of OPTIMIZATION_PASSES.entries()) {
    fcTest.prop([svgPaintTreeArb], withDefaults())(`pass #${index} is deterministic`, (tree) => {
      expect(pass(structuredClone(tree))).toEqual(pass(structuredClone(tree)))
    })

    fcTest.prop([svgPaintTreeArb], withDefaults())(`pass #${index} is idempotent`, (tree) => {
      const once = pass(tree)
      expect(pass(once)).toEqual(once)
    })

    fcTest.prop([svgPaintTreeArb], withDefaults())(
      `pass #${index} output serializes without throwing`,
      (tree) => {
        const out: SvgChild = applyOptimizationPasses(tree)
        expect(() => serializeSvg(vnode('svg', undefined, [out]))).not.toThrow()
      },
    )
  }
})
