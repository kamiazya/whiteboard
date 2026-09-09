// The version preview's real-browser claims. None survives jsdom: the palette
// one needs canvas-render's SVG injected and measured for real, and the
// navigation ones are pointer sequences against a live layout box.
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { PastDocument } from '../lib/versions-backend.js'
import { DocumentPreview } from './DocumentPreview.js'

afterEach(cleanup)

const past: PastDocument = {
  kind: 'spatial',
  canvas: {
    nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'past note' }],
    edges: [],
  },
}

const SURFACE_PX = 400

function mount(theme: 'light' | 'dark') {
  return render(
    <div style={{ width: `${SURFACE_PX}px`, height: `${SURFACE_PX}px` }}>
      <DocumentPreview past={past} theme={theme} />
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

describe('DocumentPreview', () => {
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
