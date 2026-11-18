import type { KeyedSvgRender } from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check'
import {
  type FixtureEntry,
  type FixtureRoot,
  keyedFixture,
} from '../test-utils/keyed-render-fixture'
import { mountKeyedSvg } from './keyed-svg-patcher'

const shape = (id: string, x: number): FixtureEntry => ({ key: id, x })

const paragraph = (index: number, x: number, text: string, truncated = false): FixtureEntry => ({
  key: `preamble#${index}`,
  x,
  y: 8,
  text: truncated ? `${text}…` : text,
})

const edge = (id: string, toX: number): FixtureEntry => ({ key: id, x: 100, y: 30, text: `${toX}` })

const rootOf = (container: Element): SVGSVGElement => {
  const root = container.firstElementChild
  if (!(root instanceof SVGSVGElement)) throw new Error('no mounted svg root')
  return root
}

const attrMap = (el: Element): Record<string, string> =>
  Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]))

/** The oracle: a from-scratch mount of the same render. */
function expectConverged(container: Element, next: KeyedSvgRender): void {
  const fresh = document.createElement('div')
  mountKeyedSvg(fresh, next)
  expect(rootOf(container).innerHTML).toBe(rootOf(fresh).innerHTML)
  expect(attrMap(rootOf(container))).toEqual(attrMap(rootOf(fresh)))
}

describe('mountKeyedSvg', () => {
  it('reuses untouched group elements and replaces only the changed one', () => {
    const before = keyedFixture([shape('a', 0), shape('b', 200), edge('e', 200)], {
      padding: 4,
    })
    const container = document.createElement('div')
    const patcher = mountKeyedSvg(container, before)
    const root = rootOf(container)
    const byKey = (key: string) => root.querySelector(`[data-wb-key="${key}"]`) as Element | null
    const keptA = byKey('a')
    const keptE = byKey('e')
    const oldB = byKey('b')

    const after = keyedFixture([shape('a', 0), shape('b', 220), edge('e', 200)], { padding: 4 })
    patcher.update(after)

    expect(byKey('a')).toBe(keptA)
    expect(byKey('e')).toBe(keptE)
    expect(byKey('b')).not.toBe(oldB)
    expectConverged(container, after)
  })

  it('converges across chrome transitions: background and defs appearing and disappearing', () => {
    const container = document.createElement('div')
    const first = keyedFixture([shape('a', 0), paragraph(0, 8, 'plain')])
    const patcher = mountKeyedSvg(container, first)

    const withChrome = keyedFixture([shape('a', 0), paragraph(0, 8, 'cut', true)], {
      padding: 4,
      background: '#fff',
      defs: true,
    })
    patcher.update(withChrome)
    expectConverged(container, withChrome)

    patcher.update(first)
    expectConverged(container, first)
  })

  it('converges across entry insertion, removal, and reorder', () => {
    const container = document.createElement('div')
    const a = shape('a', 0)
    const b = shape('b', 200)
    const c = shape('c', 400)
    const patcher = mountKeyedSvg(container, keyedFixture([a, b], { padding: 4 }))
    for (const entries of [[a, b, c], [c, a], [b, c, a], [b]] as const) {
      const next = keyedFixture([...entries], { padding: 4 })
      patcher.update(next)
      expectConverged(container, next)
    }
  })
})

const entryArb: fc.Arbitrary<FixtureEntry> = fc.oneof(
  fc
    .record({ id: fc.constantFrom('a', 'b', 'c', 'd'), x: fc.integer({ min: 0, max: 500 }) })
    .map(({ id, x }) => shape(id, x)),
  fc
    .record({
      text: fc.constantFrom('one', 'two', 'three'),
      x: fc.integer({ min: 0, max: 300 }),
      truncated: fc.boolean(),
    })
    .map(({ text, x, truncated }) => paragraph(0, x, text, truncated)),
  fc
    .record({ id: fc.constantFrom('e1', 'e2'), toX: fc.integer({ min: 150, max: 400 }) })
    .map(({ id, toX }) => edge(id, toX)),
)

/** Entries under distinct keys, as a document's are; a paragraph takes its place's `preamble#` key. */
const entriesArb: fc.Arbitrary<readonly FixtureEntry[]> = fc
  .array(entryArb, { minLength: 0, maxLength: 5 })
  .map((entries) => {
    const seen = new Set<string>()
    return entries.flatMap((entry, index) => {
      const key = entry.key.startsWith('preamble#') ? `preamble#${index}` : entry.key
      if (seen.has(key)) return []
      seen.add(key)
      return [{ ...entry, key }]
    })
  })

const rootArb: fc.Arbitrary<FixtureRoot> = fc.oneof(
  fc.constant({}),
  fc.constant({ padding: 4 }),
  fc.constant({ padding: 4, background: '#fff' }),
  fc.constant({ padding: 4, background: '#fff', defs: true }),
)

describe('mountKeyedSvg (PBT)', () => {
  fcTest.prop(
    [fc.array(fc.tuple(entriesArb, rootArb), { minLength: 2, maxLength: 5 })],
    withDefaults({ numRuns: 30 }),
  )('any update sequence converges to the fresh mount of the last render', (steps) => {
    const container = document.createElement('div')
    const renders = steps.map(([entries, root]) => keyedFixture(entries, root))
    const first = renders[0]
    if (first === undefined) return
    const patcher = mountKeyedSvg(container, first)
    for (const next of renders.slice(1)) {
      patcher.update(next)
      expectConverged(container, next)
    }
  })
})
