import type { KeyedSvgRender } from '@kamiazya/whiteboard-canvas-render'
import { act, cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { type FixtureEntry, keyedFixture } from '../test-utils/keyed-render-fixture'
import { useKeyedSvg } from './use-keyed-svg'

afterEach(cleanup)

const shape = (id: string, x: number): FixtureEntry => ({ key: id, x })

const keyedOf = (entries: FixtureEntry[]): KeyedSvgRender => keyedFixture(entries, { padding: 4 })

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

/**
 * The editor patches ONE container from two producers — the committed
 * render, and the drag backdrop that excludes whatever the drag layer is
 * carrying live. Crossing between them is not an edit, and the annotation
 * layer's arrive/leave ramp must not read it as one: a grabbed comment pin
 * would otherwise fade out at the anchor the pointer just left, under the
 * preview holding it, for the length of the gesture.
 */
const pin = (id: string): FixtureEntry => ({
  key: `${id}/pin`,
  x: 300,
  fill: '#d97706',
  annotation: true,
})

let setSource: (next: string) => void = () => {}

function SwitchingHost({ initial }: { readonly initial: KeyedSvgRender }) {
  const [keyed, set] = useState(initial)
  const [source, setSrc] = useState('committed')
  setKeyed = set
  setSource = setSrc
  return <div data-testid="surface" ref={useKeyedSvg(keyed, source)} />
}

it('takes a pin out at once when the render source changed, and ramps it when only the scene did', () => {
  const { container } = render(<SwitchingHost initial={keyedOf([shape('a', 0), pin('c1')])} />)
  const pinEl = () => container.querySelector('[data-wb-key="c1/pin"]')

  // Same source, pin gone: an edit, so it ramps and is still on screen.
  act(() => setKeyed(keyedOf([shape('a', 0)])))
  expect(pinEl()).not.toBeNull()

  // Back, then out again in the SAME commit as a source change: a layer
  // swap, so it goes immediately.
  act(() => setKeyed(keyedOf([shape('a', 0), pin('c1')])))
  act(() => {
    setSource('drag-backdrop')
    setKeyed(keyedOf([shape('a', 0)]))
  })
  expect(pinEl()).toBeNull()
})
