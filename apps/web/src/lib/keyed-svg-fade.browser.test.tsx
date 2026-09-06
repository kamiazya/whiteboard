/**
 * Resolving a conversation on the canvas MOVES it out rather than deleting
 * it between two frames.
 *
 * Measured before designing this: with the default `showResolved`, resolve
 * does not recolour the pin — the pin, its count, the leader and the whole
 * bubble leave the scene together, so the patcher was removing five groups
 * in one tick. With the toggle on they all change paint instead. Both read
 * as a cut, and both are the same press.
 *
 * Scoped to the annotation layer by the producer's own mark, never by the
 * key's shape, and never universally: a document group replaced in place is
 * a keystroke inside a node, and cross-fading those would ghost while
 * someone types.
 *
 * Real browser: a `getAnimations()` entry is the claim, and jsdom cannot
 * make it.
 */
import { renderSceneToKeyedSvg, type SceneNode } from '@kamiazya/whiteboard-canvas-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountKeyedSvg } from './keyed-svg-patcher'

const node = (id: string, fill = '#fff'): SceneNode => ({
  kind: 'shape',
  id,
  bbox: { x: 0, y: 0, w: 100, h: 60 },
  appearance: { fill, stroke: '#333' },
})

/** A comment pin: the producer marks it, and this layer never guesses. */
const pin = (id: string, fill = '#d97706'): SceneNode => ({
  kind: 'shape',
  id: `${id}/pin`,
  commentChrome: true,
  bbox: { x: 200, y: 0, w: 20, h: 20 },
  radius: 10,
  appearance: { fill },
})

const keyedOf = (nodes: SceneNode[]) =>
  renderSceneToKeyedSvg({ nodes }, { padding: 4, viewBox: { x: 0, y: 0, w: 600, h: 400 } })

let mounted: HTMLElement | null = null
afterEach(() => {
  mounted?.remove()
  mounted = null
})

function mount(nodes: SceneNode[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  mounted = container
  const patcher = mountKeyedSvg(container, keyedOf(nodes))
  const byKey = (key: string) => container.querySelector(`[data-wb-key="${key}"]`)
  const running = () =>
    [...(patcher.root.children as unknown as Iterable<Element>)].flatMap((child) =>
      child.getAnimations().map(() => child.getAttribute('data-wb-key') ?? '?'),
    )
  return { container, patcher, byKey, running }
}

describe('an annotation group leaving the scene', () => {
  it('stays on screen fading rather than vanishing between frames', async () => {
    const { patcher, byKey, running } = mount([node('a'), pin('c1')])
    patcher.update(keyedOf([node('a')]))

    // Still in the document, and animating: the press has something to read.
    expect(byKey('c1/pin')).not.toBeNull()
    expect(running()).toContain('c1/pin')

    // And it does go, without another update to push it out.
    await vi.waitFor(() => expect(byKey('c1/pin')).toBeNull(), { timeout: 4000 })
  })

  it('takes a document group out at once, which is what keeps typing from ghosting', () => {
    const { patcher, byKey } = mount([node('a'), node('b')])
    patcher.update(keyedOf([node('a')]))
    expect(byKey('b')).toBeNull()
  })
})

describe('an annotation group arriving or changing paint', () => {
  it('fades in on arrival, so a reopened conversation is not simply there', () => {
    const { patcher, byKey } = mount([node('a')])
    patcher.update(keyedOf([node('a'), pin('c1')]))
    expect(byKey('c1/pin')?.getAnimations() ?? []).toHaveLength(1)
  })

  it('crosses to the muted look with both halves on screen at once', () => {
    // The `showResolved` case: same key, same geometry, new paint. The old
    // element is kept so the ramp is continuous rather than a swap.
    const { patcher, byKey, running } = mount([node('a'), pin('c1')])
    patcher.update(keyedOf([node('a'), pin('c1', '#c0c0c0')]))
    expect(byKey('c1/pin')?.getAnimations() ?? []).toHaveLength(1)
    // Two elements animating under one key: the outgoing ghost and the
    // incoming group.
    expect(running().filter((key) => key === 'c1/pin')).toHaveLength(2)
  })

  it('leaves a document group replaced in place alone', () => {
    const { patcher, byKey } = mount([node('a')])
    patcher.update(keyedOf([node('a', '#eee')]))
    expect(byKey('a')?.getAnimations() ?? []).toHaveLength(0)
  })
})

describe('what the fade must not outlive', () => {
  it('converges to exactly the groups, with no ghost and no inline style left', async () => {
    const { container, patcher } = mount([node('a'), pin('c1')])
    patcher.update(keyedOf([node('a')]))
    await vi.waitFor(() => expect(patcher.root.children).toHaveLength(1), { timeout: 4000 })

    // Byte-equal to a fresh mount: WAAPI writes no style attribute, and the
    // ghost is gone. A patched DOM that drifts from a mounted one is the
    // whole thing this layer must not do.
    const fresh = document.createElement('div')
    fresh.innerHTML = keyedOf([node('a')]).svg
    expect(container.innerHTML).toBe(fresh.innerHTML)
  })

  it('drops a still-fading ghost when the next update lands', () => {
    const { patcher, container } = mount([node('a'), pin('c1')])
    patcher.update(keyedOf([node('a')]))
    patcher.update(keyedOf([node('a'), node('b')]))
    expect(container.querySelector('[data-wb-key="c1/pin"]')).toBeNull()
  })

  it('does nothing at all when the host turned motion off', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    mounted = container
    const patcher = mountKeyedSvg(container, keyedOf([node('a'), pin('c1')]), { motion: false })
    patcher.update(keyedOf([node('a')]))
    expect(container.querySelector('[data-wb-key="c1/pin"]')).toBeNull()
  })
})

describe('a layer swap is not a document change', () => {
  it('lets a pin the drag layer took over leave without a ghost under the preview', () => {
    // `use-drag-layers` patches the same container to the drag BACKDROP for
    // the length of a gesture, and that backdrop excludes what the drag
    // layer draws live. Grabbing a pin therefore reaches this layer as a
    // removal — and a fading copy of it, sitting at the anchor the pointer
    // just left, is a second pin on screen for the whole gesture.
    const { patcher, container } = mount([node('a'), pin('c1')])
    patcher.update(keyedOf([node('a')]), { animate: false })
    expect(container.querySelector('[data-wb-key="c1/pin"]')).toBeNull()
  })
})
