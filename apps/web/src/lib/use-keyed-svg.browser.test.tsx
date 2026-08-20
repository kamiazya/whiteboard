import {
  type KeyedSvgRender,
  renderSceneToKeyedSvg,
  type SceneNode,
} from '@kamiazya/whiteboard-canvas-render'
import { act, cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { useKeyedSvg } from './use-keyed-svg'

afterEach(cleanup)

const shape = (id: string, x: number): SceneNode => ({
  kind: 'shape',
  id,
  bbox: { x, y: 0, w: 100, h: 60 },
  appearance: { fill: '#fff', stroke: '#333' },
})

const keyedOf = (nodes: SceneNode[]): KeyedSvgRender =>
  renderSceneToKeyedSvg({ nodes }, { padding: 4 })

let setKeyed: (next: KeyedSvgRender) => void = () => {}
let bumpUnrelated: () => void = () => {}

function Host({ initial }: { readonly initial: KeyedSvgRender }) {
  const [keyed, set] = useState(initial)
  const [, bump] = useState(0)
  setKeyed = set
  bumpUnrelated = () => bump((n) => n + 1)
  return <div data-testid="surface" ref={useKeyedSvg(keyed)} />
}

it('mounts once, and a keyed prop change patches only the changed group', () => {
  const { container } = render(<Host initial={keyedOf([shape('a', 0), shape('b', 200)])} />)
  const byKey = (key: string) => container.querySelector(`[data-wb-key="${key}"]`)
  const keptA = byKey('a')
  const oldB = byKey('b')
  expect(keptA).not.toBeNull()

  act(() => setKeyed(keyedOf([shape('a', 0), shape('b', 240)])))
  expect(byKey('a')).toBe(keptA)
  expect(byKey('b')).not.toBe(oldB)
  expect(byKey('b')?.outerHTML).toContain('x="240"')
})

it('a parent re-render without a keyed change leaves the patched DOM untouched', () => {
  const { container } = render(<Host initial={keyedOf([shape('a', 0)])} />)
  const root = container.querySelector('svg')
  const group = container.querySelector('[data-wb-key="a"]')

  act(() => bumpUnrelated())
  expect(container.querySelector('svg')).toBe(root)
  expect(container.querySelector('[data-wb-key="a"]')).toBe(group)
})
