import architectureRaw from '@docs-assets/architecture.canvas?raw'
import { parseSpatial } from '@kamiazya/whiteboard-canvas-codec'
import { CanvasViewer, ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, it } from 'vitest'
import { page } from 'vitest/browser'
import { resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/canvas-presentation.png — the same architecture
// scene rendered chrome-free at a larger viewport, suitable for embedding
// in docs. This is a plain canvas render, not a capture of the app's real
// fullscreen route (apps/web/src/lib/canvas-fullscreen-hash.ts) — see the
// README caption this image backs.

const parsed = parseSpatial(architectureRaw)
if (!parsed.ok) {
  throw new Error(`architecture.canvas failed to parse: ${parsed.error.message}`)
}
const scene = parsed.value

afterEach(() => {
  cleanup()
})

describe('docs snapshot — canvas presentation render', () => {
  it('writes docs/assets/canvas-presentation.png', async () => {
    await ensureViewerFontLoaded()

    const { container } = render(
      <CanvasViewer
        canvas={scene}
        width={1280}
        height={760}
        padding={60}
        background="#ffffff"
        testId="canvas-presentation-scene"
      />,
    )

    await waitFor(() => {
      const svgs = container.querySelectorAll('svg')
      // CanvasViewer's SVG is always the last one in document order — icon
      // svgs (WorkspaceTopBar chevrons, kebab menus, etc.) render ahead of it.
      const svg = svgs[svgs.length - 1]
      if (!svg) throw new Error('scene svg not yet mounted')
      if (!(svg.textContent ?? '').includes('Whiteboard')) {
        throw new Error('scene content not yet rendered')
      }
    })

    const target = container.querySelector('[data-testid="canvas-presentation-scene"]')
    if (!(target instanceof HTMLElement)) throw new Error('viewer wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('canvas-presentation.png'),
      element: page.elementLocator(target),
    })
  })
})
