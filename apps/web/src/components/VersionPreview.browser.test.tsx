// The version preview's real-browser claims. None survives jsdom: the palette
// one needs canvas-render's SVG injected and measured for real, and the
// navigation ones are pointer and wheel sequences against a live layout box.

import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { PastDocument } from '../lib/versions-backend.js'
import { VersionPreview } from './VersionPreview.js'

afterEach(cleanup)

const past: PastDocument = {
  kind: 'spatial',
  canvas: {
    nodes: [textNode({ id: 'a', x: 0, y: 0, width: 200, height: 100, text: 'past note' })],
    edges: [],
  },
}

const SURFACE_PX = 400

function mount(theme: 'light' | 'dark', offsetPx = 0) {
  return render(
    <div
      style={{ width: `${SURFACE_PX}px`, height: `${SURFACE_PX}px`, marginLeft: `${offsetPx}px` }}
    >
      <VersionPreview past={past} theme={theme} />
    </div>,
  )
}

const chromeStroke = (container: HTMLElement): string | null =>
  container.querySelector('svg rect')?.getAttribute('stroke') ?? null

function pointer(
  type: string,
  pointerId: number,
  x: number,
  y: number,
  init: PointerEventInit = {},
): void {
  page
    .getByTestId('document-preview')
    .element()
    .dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        pointerId,
        button: 0,
        ...init,
      }),
    )
}

/**
 * A wheel over the surface, `at` in the surface's own pixels. Answers whether
 * the event was left uncancelled — false means the handler refused the
 * browser's default.
 */
function wheel(init: WheelEventInit & { readonly at?: readonly [number, number] }): boolean {
  const surface = page.getByTestId('document-preview').element()
  const rect = surface.getBoundingClientRect()
  const [x, y] = init.at ?? [100, 100]
  return surface.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
      ...init,
    }),
  )
}

/** One finger, +60/+40 — the pan every navigation test below starts from. */
function drag(): void {
  pointer('pointerdown', 1, 200, 200)
  pointer('pointermove', 1, 260, 240)
  pointer('pointerup', 1, 260, 240)
}

/** The transform the surface currently carries, which is the viewport. */
const transformOf = (container: HTMLElement): string =>
  (container.querySelector('[data-testid="preview-viewport"]') as HTMLElement).style.transform

/** Scale factor read back out of that transform; NaN if it carries none. */
const scaleOf = (container: HTMLElement): number =>
  Number(/scale\(([^)]+)\)/.exec(transformOf(container))?.[1] ?? Number.NaN)

/** The viewport read back out of the transform, as numbers. */
function viewOf(container: HTMLElement): { zoom: number; x: number; y: number } {
  const transform = transformOf(container)
  const m = /scale\(([^)]+)\) translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(transform)
  if (m === null) throw new Error(`no viewport transform in ${JSON.stringify(transform)}`)
  return { zoom: Number(m[1]), x: Number(m[2]), y: Number(m[3]) }
}

/**
 * Mounts and waits out the first ResizeObserver reflow, so coordinates taken
 * from the layout box are the ones the gesture lands on.
 */
async function mountSettled(offsetPx = 0): Promise<HTMLElement> {
  const { container } = mount('light', offsetPx)
  await expect
    .poll(() => container.querySelector('svg')?.getAttribute('width'))
    .toBe(String(SURFACE_PX))
  return container
}

const fitControl = (container: HTMLElement): Element | null =>
  container.querySelector('[data-testid="preview-fit-view"]')

describe('VersionPreview', () => {
  it('draws a past canvas in the theme the app is in', async () => {
    const dark = mount('dark')
    await expect
      .poll(() => chromeStroke(dark.container))
      .toBe(SPATIAL_DARK_PALETTE.node.text.stroke)
    cleanup()

    const light = mount('light')
    await expect
      .poll(() => chromeStroke(light.container))
      .toBe(SPATIAL_LIGHT_PALETTE.node.text.stroke)
  })

  it('pans the past canvas under a drag', async () => {
    const { container } = mount('dark')
    // The viewer sizes itself from a ResizeObserver, so the drawn box moves
    // once after the first paint. Measuring the baseline before that settles
    // reads that reflow as part of the pan.
    await expect
      .poll(() => container.querySelector('svg')?.getAttribute('width'))
      .toBe(String(SURFACE_PX))
    const rect = () =>
      (container.querySelector('svg rect') as SVGRectElement).getBoundingClientRect()
    const before = rect()
    drag()

    await expect
      .poll(() => {
        const now = rect()
        return { dx: Math.round(now.left - before.left), dy: Math.round(now.top - before.top) }
      })
      .toEqual({ dx: 60, dy: 40 })
  })

  it('offers the way back to the fitted view once it has been moved', async () => {
    const { container } = mount('dark')
    await expect
      .poll(() => container.querySelector('svg')?.getAttribute('width'))
      .toBe(String(SURFACE_PX))
    expect(container.querySelector('[data-testid="preview-fit-view"]')).toBeNull()
    drag()

    const fit = page.getByTestId('preview-fit-view')
    await userEvent.click(fit)
    await expect.poll(() => transformOf(container)).toBe('scale(1) translate(0px, 0px)')
    expect(container.querySelector('[data-testid="preview-fit-view"]')).toBeNull()
  })

  // Pointer capture is best-effort (a browser refuses it for a pointerId the
  // platform has no record of), so a release OUTSIDE the surface can deliver
  // no `pointerup` at all. A press the surface never saw end must not leave a
  // drag armed: the button is up, and the next hover is not a pan.
  it('drops a mouse drag whose release the surface never saw', async () => {
    const { container } = mount('dark')
    await expect
      .poll(() => container.querySelector('svg')?.getAttribute('width'))
      .toBe(String(SURFACE_PX))

    pointer('pointerdown', 1, 200, 200, { pointerType: 'mouse', buttons: 1 })
    pointer('pointermove', 1, 260, 240, { pointerType: 'mouse', buttons: 1 })
    await expect.poll(() => transformOf(container)).toBe('scale(1) translate(60px, 40px)')

    // The release landed off the surface. These are hovers, not a drag.
    pointer('pointermove', 1, 340, 340, { pointerType: 'mouse', buttons: 0 })
    pointer('pointermove', 1, 380, 380, { pointerType: 'mouse', buttons: 0 })
    // Asserted through what the NEXT real drag arrives at rather than by
    // waiting to see nothing happen: a press that ends here moves the view by
    // its own +20/+20 and no more. With the hovers counted the surface is
    // already at translate(180px, 180px) by now, so this value is out of
    // reach — which is the whole claim, stated as something that comes true.
    pointer('pointerdown', 1, 380, 380, { pointerType: 'mouse', buttons: 1 })
    pointer('pointermove', 1, 400, 400, { pointerType: 'mouse', buttons: 1 })

    await expect.poll(() => transformOf(container)).toBe('scale(1) translate(80px, 60px)')
  })

  // The other way a press ends without an up: the platform takes the capture
  // away mid-drag. The editor answers this the same way (`onLostPointerCapture`).
  it('drops a drag whose capture the platform revoked', async () => {
    const { container } = mount('dark')
    await expect
      .poll(() => container.querySelector('svg')?.getAttribute('width'))
      .toBe(String(SURFACE_PX))

    pointer('pointerdown', 1, 200, 200)
    pointer('pointermove', 1, 260, 240)
    await expect.poll(() => transformOf(container)).toBe('scale(1) translate(60px, 40px)')

    pointer('lostpointercapture', 1, 260, 240)
    pointer('pointermove', 1, 340, 340)
    // Same shape as above: the next real drag adds its own +20/+20 and
    // nothing the revoked press left behind.
    pointer('pointerdown', 1, 340, 340)
    pointer('pointermove', 1, 360, 360)

    await expect.poll(() => transformOf(container)).toBe('scale(1) translate(80px, 60px)')
  })

  // The screen this surface is most often read on has no wheel and no
  // keyboard, so the pinch is the only way to get closer to anything on it.
  it('zooms the past canvas under a two-finger pinch', async () => {
    const { container } = mount('dark')
    await expect
      .poll(() => container.querySelector('svg')?.getAttribute('width'))
      .toBe(String(SURFACE_PX))
    expect(scaleOf(container)).toBe(1)

    pointer('pointerdown', 1, 180, 200)
    pointer('pointerdown', 2, 220, 200)
    // Same midpoint, twice the spread: a pure zoom with no pan in it.
    pointer('pointermove', 1, 160, 200)
    pointer('pointermove', 2, 240, 200)
    pointer('pointerup', 1, 160, 200)
    pointer('pointerup', 2, 240, 200)

    await expect.poll(() => scaleOf(container)).toBeCloseTo(2, 1)
  })
})

/**
 * The dock states this operation without a word — a `Focus` glyph labelled
 * "Zoom to fit" — and its own comment says there is nothing to reset to. The
 * preview had a text button reading "Reset view", which is both the wrong
 * vocabulary and the one surface that spells a view control out.
 *
 * The operation is the same one: the preview's untouched viewport IS the
 * fitted view, since the scene is rendered to fit its box before any
 * transform is applied.
 */
describe('the preview view control', () => {
  it("says it the way the dock does — a glyph, no words, and the dock's own name", async () => {
    const { container } = mount('light')
    // The surface reflows once the scene is measured, and a drag dispatched
    // at coordinates from before that lands somewhere else.
    await expect
      .poll(() => container.querySelector('svg')?.getAttribute('width'))
      .toBe(String(SURFACE_PX))

    // Move it, so the control is on screen at all.
    drag()

    await expect
      .poll(() => container.querySelector('[data-testid="preview-fit-view"]'))
      .not.toBeNull()
    const fit = container.querySelector('[data-testid="preview-fit-view"]') as HTMLElement
    expect(fit?.getAttribute('aria-label')).toBe('Zoom to fit')
    // Non-verbal: the glyph carries it, and no words are drawn.
    expect(fit?.querySelector('svg')).not.toBeNull()
    expect(fit?.textContent?.trim()).toBe('')
    // The retired vocabulary is gone rather than merely hidden.
    expect(container.textContent).not.toContain('Reset view')
  })
})

/**
 * Wheel and trackpad are the desktop way round a past state, and every claim
 * here is one a refactor can break while the drag and pinch tests stay green.
 */
describe('the preview under a wheel', () => {
  // The listener is native and non-passive for exactly this: a default left
  // standing makes Ctrl/Cmd+wheel zoom the whole page.
  it('pans a plain wheel against the scroll and refuses the page its default', async () => {
    const container = await mountSettled()
    expect(wheel({ deltaX: 10, deltaY: 30 })).toBe(false)
    await expect.poll(() => viewOf(container)).toEqual({ zoom: 1, x: -10, y: -30 })
  })

  it('zooms in under Ctrl+wheel up, holding the picture point under the pointer', async () => {
    const container = await mountSettled()
    expect(wheel({ deltaY: -100, ctrlKey: true, at: [100, 100] })).toBe(false)
    await expect.poll(() => viewOf(container).zoom).toBeCloseTo(1.1, 5)
    // The point under (100, 100) stays there: translate = -(100 - 100 / 1.1).
    expect(viewOf(container).x).toBeCloseTo(-(100 - 100 / 1.1), 3)
    expect(viewOf(container).y).toBeCloseTo(-(100 - 100 / 1.1), 3)
  })

  it('zooms out under Ctrl+wheel down, and zooms under Cmd+wheel the way it does under Ctrl', async () => {
    const container = await mountSettled()
    wheel({ deltaY: 100, ctrlKey: true })
    await expect.poll(() => viewOf(container).zoom).toBeCloseTo(1 / 1.1, 5)
    wheel({ deltaY: -100, metaKey: true })
    await expect.poll(() => viewOf(container).zoom).toBeCloseTo(1, 5)
  })

  it('offers the way back after a zoom alone, and after a sideways pan alone', async () => {
    const zoomed = await mountSettled()
    expect(fitControl(zoomed)).toBeNull()
    // Zooming about the origin leaves the translation at zero.
    wheel({ deltaY: -100, ctrlKey: true, at: [0, 0] })
    await expect.poll(() => viewOf(zoomed).zoom).toBeCloseTo(1.1, 5)
    expect(viewOf(zoomed).x).toBeCloseTo(0, 5)
    await expect.poll(() => fitControl(zoomed)).not.toBeNull()
    cleanup()

    const panned = await mountSettled()
    wheel({ deltaX: 25, deltaY: 0 })
    await expect.poll(() => viewOf(panned)).toEqual({ zoom: 1, x: -25, y: 0 })
    await expect.poll(() => fitControl(panned)).not.toBeNull()
  })
})

describe('the preview under pointer presses', () => {
  // Each claim is asserted through what the NEXT real drag arrives at, so it
  // is something that comes true rather than a wait to see nothing happen.
  it('does not pan under a right-button drag', async () => {
    const container = await mountSettled()
    pointer('pointerdown', 1, 200, 200, { pointerType: 'mouse', button: 2, buttons: 2 })
    pointer('pointermove', 1, 260, 240, { pointerType: 'mouse', buttons: 2 })
    pointer('pointerup', 1, 260, 240, { pointerType: 'mouse', button: 2 })
    pointer('pointerdown', 1, 260, 240, { pointerType: 'mouse', buttons: 1 })
    pointer('pointermove', 1, 280, 260, { pointerType: 'mouse', buttons: 1 })
    await expect.poll(() => viewOf(container)).toEqual({ zoom: 1, x: 20, y: 20 })
  })

  for (const end of ['pointerup', 'pointercancel'] as const) {
    it(`ends a touch drag on ${end}, so the next finger pans instead of pinching`, async () => {
      const container = await mountSettled()
      pointer('pointerdown', 1, 200, 200, { pointerType: 'touch' })
      pointer('pointermove', 1, 220, 220, { pointerType: 'touch' })
      pointer(end, 1, 220, 220, { pointerType: 'touch' })
      pointer('pointerdown', 2, 100, 100, { pointerType: 'touch' })
      pointer('pointermove', 2, 110, 110, { pointerType: 'touch' })
      await expect.poll(() => viewOf(container)).toEqual({ zoom: 1, x: 30, y: 30 })
    })
  }

  // The anchor is in the surface's own pixels; reading it in client pixels
  // drifts the zoom by the surface's page offset.
  it('holds the picture point under a pinch midpoint wherever the surface sits on the page', async () => {
    const container = await mountSettled(60)
    const left = page.getByTestId('document-preview').element().getBoundingClientRect().left
    expect(left).toBeGreaterThan(50)
    pointer('pointerdown', 1, 180, 200)
    pointer('pointerdown', 2, 220, 200)
    pointer('pointermove', 1, 160, 200)
    pointer('pointermove', 2, 240, 200)
    await expect.poll(() => viewOf(container).zoom).toBeCloseTo(2, 5)
    expect(viewOf(container).x).toBeCloseTo(-(200 - left) / 2, 3)
  })

  it('pans with a two-finger drag that keeps its spread', async () => {
    const container = await mountSettled()
    pointer('pointerdown', 1, 180, 200)
    pointer('pointerdown', 2, 220, 200)
    pointer('pointermove', 2, 260, 200)
    pointer('pointermove', 1, 220, 200)
    await expect.poll(() => viewOf(container).x).toBeCloseTo(40, 3)
    expect(viewOf(container).zoom).toBeCloseTo(1, 5)
  })
})
