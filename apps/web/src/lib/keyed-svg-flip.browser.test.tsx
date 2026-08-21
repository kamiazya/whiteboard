import { renderSceneToKeyedSvg, type SceneNode } from '@kamiazya/whiteboard-canvas-render'
import { afterEach, describe, expect, it } from 'vitest'
import { mountKeyedSvg } from './keyed-svg-patcher'

const shape = (id: string, x: number, fill = '#fff'): SceneNode => ({
  kind: 'shape',
  id,
  bbox: { x, y: 0, w: 100, h: 60 },
  appearance: { fill, stroke: '#333' },
})

const keyedOf = (nodes: SceneNode[]) =>
  renderSceneToKeyedSvg({ nodes }, { padding: 4, viewBox: { x: 0, y: 0, w: 600, h: 400 } })

let mounted: HTMLElement | null = null
afterEach(() => {
  mounted?.remove()
  mounted = null
})

/** FLIP needs real layout, so the container must be in the document. */
function mount(nodes: SceneNode[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  mounted = container
  const patcher = mountKeyedSvg(container, keyedOf(nodes))
  const byKey = (key: string) =>
    container.querySelector(`[data-wb-key="${key}"]`) as SVGGElement | null
  return { container, patcher, byKey }
}

describe('keyed patching animates moves (FLIP)', () => {
  it('a replaced group animates from its old position; untouched groups do not', () => {
    const { patcher, byKey } = mount([shape('a', 0), shape('b', 200)])
    patcher.update(keyedOf([shape('a', 0), shape('b', 320)]))

    const animations = byKey('b')?.getAnimations() ?? []
    expect(animations).toHaveLength(1)
    expect(byKey('a')?.getAnimations() ?? []).toHaveLength(0)
  })

  it('an INSERTED key appears without animation — a local drop commit must not fly in', () => {
    // During a drag the static backdrop excludes the dragged node, so the
    // commit on drop arrives as an insertion. Animating insertions would
    // double-move exactly that case; only same-key replacements animate.
    const { patcher, byKey } = mount([shape('a', 0)])
    patcher.update(keyedOf([shape('a', 0), shape('b', 320)]))
    expect(byKey('b')?.getAnimations() ?? []).toHaveLength(0)
  })

  it('a replaced group whose position did not move gets no animation', () => {
    // Same key, changed bytes (fill), same geometry: an edit-in-place must
    // not wiggle.
    const { patcher, byKey } = mount([shape('a', 0)])
    patcher.update(keyedOf([shape('a', 0, '#eee')]))
    expect(byKey('a')?.getAnimations() ?? []).toHaveLength(0)
  })

  it('motion: false disables move animation entirely', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    mounted = container
    const patcher = mountKeyedSvg(container, keyedOf([shape('a', 0)]), { motion: false })
    patcher.update(keyedOf([shape('a', 240)]))
    const group = container.querySelector('[data-wb-key="a"]') as SVGGElement
    expect(group.getAnimations()).toHaveLength(0)
  })

  it('the move delta is measured in user units, so an editor zoom does not overshoot', () => {
    // The editor scales the whole surface for zoom; screen-px deltas are
    // divided back to SVG user units before the translate keyframe.
    const parent = document.createElement('div')
    parent.style.transform = 'scale(2)'
    parent.style.transformOrigin = '0 0'
    document.body.appendChild(parent)
    mounted = parent
    const container = document.createElement('div')
    parent.appendChild(container)
    const patcher = mountKeyedSvg(container, keyedOf([shape('a', 0)]))
    patcher.update(keyedOf([shape('a', 240)]))
    const group = container.querySelector('[data-wb-key="a"]') as SVGGElement
    const [animation] = group.getAnimations()
    const keyframes =
      animation?.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : []
    expect(keyframes[0]?.transform).toBe('translate(-240px, 0px)')
  })

  it('the animation ends at the natural position (no lingering transform)', async () => {
    const { patcher, byKey } = mount([shape('a', 0)])
    patcher.update(keyedOf([shape('a', 240)]))
    const group = byKey('a') as SVGGElement
    await Promise.all(group.getAnimations().map((animation) => animation.finished))
    expect(group.getAnimations()).toHaveLength(0)
    expect(group.getAttribute('style')).toBeNull()
  })
})
