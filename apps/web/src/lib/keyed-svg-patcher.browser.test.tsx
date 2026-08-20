import {
  type KeyedSvgRender,
  renderSceneToKeyedSvg,
  type Scene,
  type SceneNode,
  type SvgDocumentOptions,
} from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check'
import { mountKeyedSvg } from './keyed-svg-patcher'

const shape = (id: string, x: number): SceneNode => ({
  kind: 'shape',
  id,
  bbox: { x, y: 0, w: 100, h: 60 },
  radius: 4,
  appearance: { fill: '#fff', stroke: '#333' },
})

const paragraph = (x: number, text: string, truncated = false): SceneNode => ({
  kind: 'paragraph',
  bbox: { x, y: 8, w: 80, h: 16 },
  runs: [
    {
      kind: 'textRun',
      bbox: { x, y: 8, w: 40, h: 16 },
      text,
      ...(truncated ? { truncated: true as const } : {}),
    },
  ],
})

const edge = (id: string, fromX: number, toX: number): SceneNode => ({
  kind: 'edge',
  id,
  path: [
    { x: fromX, y: 30 },
    { x: toX, y: 30 },
  ],
  fromSide: 'right',
  toSide: 'left',
  fromEnd: 'none',
  toEnd: 'arrow',
  appearance: { stroke: '#888' },
})

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
    const before = renderSceneToKeyedSvg(
      { nodes: [shape('a', 0), shape('b', 200), edge('e', 100, 200)] },
      { padding: 4 },
    )
    const container = document.createElement('div')
    const patcher = mountKeyedSvg(container, before)
    const root = rootOf(container)
    const byKey = (key: string) => root.querySelector(`[data-wb-key="${key}"]`) as Element | null
    const keptA = byKey('a')
    const keptE = byKey('e')
    const oldB = byKey('b')

    const after = renderSceneToKeyedSvg(
      { nodes: [shape('a', 0), shape('b', 220), edge('e', 100, 200)] },
      { padding: 4 },
    )
    patcher.update(after)

    expect(byKey('a')).toBe(keptA)
    expect(byKey('e')).toBe(keptE)
    expect(byKey('b')).not.toBe(oldB)
    expectConverged(container, after)
  })

  it('converges across chrome transitions: background and defs appearing and disappearing', () => {
    const container = document.createElement('div')
    const first = renderSceneToKeyedSvg({ nodes: [shape('a', 0), paragraph(8, 'plain')] })
    const patcher = mountKeyedSvg(container, first)

    const withChrome = renderSceneToKeyedSvg(
      { nodes: [shape('a', 0), paragraph(8, 'cut…', true)] },
      { padding: 4, background: '#fff' },
    )
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
    const patcher = mountKeyedSvg(
      container,
      renderSceneToKeyedSvg({ nodes: [a, b] }, { padding: 4 }),
    )
    for (const nodes of [[a, b, c], [c, a], [b, c, a], [b]] as const) {
      const next = renderSceneToKeyedSvg({ nodes: [...nodes] }, { padding: 4 })
      patcher.update(next)
      expectConverged(container, next)
    }
  })
})

const entryArb: fc.Arbitrary<SceneNode> = fc.oneof(
  fc
    .record({ id: fc.constantFrom('a', 'b', 'c', 'd'), x: fc.integer({ min: 0, max: 500 }) })
    .map(({ id, x }) => shape(id, x)),
  fc
    .record({
      text: fc.constantFrom('one', 'two', 'three'),
      x: fc.integer({ min: 0, max: 300 }),
      truncated: fc.boolean(),
    })
    .map(({ text, x, truncated }) => paragraph(x, text, truncated)),
  fc
    .record({ id: fc.constantFrom('e1', 'e2'), toX: fc.integer({ min: 150, max: 400 }) })
    .map(({ id, toX }) => edge(id, 100, toX)),
)

const sceneArb: fc.Arbitrary<Scene> = fc
  .array(entryArb, { minLength: 0, maxLength: 5 })
  .map((nodes) => ({ nodes }))

const optionsArb: fc.Arbitrary<SvgDocumentOptions | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant({ padding: 4 }),
  fc.constant({ padding: 4, background: '#fff' }),
)

describe('mountKeyedSvg (PBT)', () => {
  fcTest.prop(
    [fc.array(fc.tuple(sceneArb, optionsArb), { minLength: 2, maxLength: 5 })],
    withDefaults({ numRuns: 30 }),
  )('any update sequence converges to the fresh mount of the last render', (steps) => {
    const container = document.createElement('div')
    const renders = steps.map(([scene, options]) => renderSceneToKeyedSvg(scene, options))
    const first = renders[0]
    if (first === undefined) return
    const patcher = mountKeyedSvg(container, first)
    for (const next of renders.slice(1)) {
      patcher.update(next)
      expectConverged(container, next)
    }
  })
})
