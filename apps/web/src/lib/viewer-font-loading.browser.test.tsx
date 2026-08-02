// Real-browser lock on the apps/web bootstrap seam: without a registered
// face, Canvas 2D silently falls back to a system font when asked for the
// viewer family, producing byte-identical widths to a deliberately bogus
// family. jsdom has no font stack and cannot see this — only a real browser
// can. `document.fonts.check()` reports `true` for the bogus family too and
// must never be used as this guard.

import type { FontDescriptor } from '@kamiazya/whiteboard-canvas-render'
import {
  createBrowserMeasureText,
  ensureViewerFontLoaded,
  VIEWER_FONT_FAMILY,
} from '@kamiazya/whiteboard-canvas-viewer'
import { describe, expect, it } from 'vitest'

const SAMPLE_TEXT = 'The quick brown fox jumps'
const SIZE_PX = 16
const BOGUS_FAMILY = 'ThisFontDoesNotExist12345'

function fontDescriptor(family: string): FontDescriptor {
  return { family, fallbackChain: [], weight: 400, style: 'normal', sizePx: SIZE_PX }
}

describe('viewer font loading (apps/web bootstrap seam)', () => {
  it('measures the intended family with a different advance width than a bogus family once loaded', async () => {
    const status = await ensureViewerFontLoaded()
    expect(status).toBe('loaded')

    const measure = createBrowserMeasureText()
    const real = measure(SAMPLE_TEXT, fontDescriptor(VIEWER_FONT_FAMILY))
    const bogus = measure(SAMPLE_TEXT, fontDescriptor(BOGUS_FAMILY))

    // This is the discriminator, not a hardcoded pixel value: a silent
    // fallback to the platform default produces the SAME width for both
    // requests, which is exactly the bug on unmodified main.
    expect(real.advanceWidth).not.toBe(bogus.advanceWidth)
  })

  it('registers the viewer font family as loaded in document.fonts', async () => {
    await ensureViewerFontLoaded()

    const loaded = Array.from(document.fonts).some(
      (face) =>
        face.family.replace(/^["']|["']$/g, '') === VIEWER_FONT_FAMILY && face.status === 'loaded',
    )
    expect(loaded).toBe(true)
  })
})
