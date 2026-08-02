import architectureRaw from '@docs-assets/architecture.canvas?raw'
import { parseSpatial } from '@kamiazya/whiteboard-canvas-codec'
import { CanvasViewer, ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, it } from 'vitest'
import { page } from 'vitest/browser'
import { resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/architecture.png by rendering the canonical
// architecture.canvas JSON Canvas source. The .canvas file is the source of
// truth — re-running this test re-renders it deterministically so a scene
// edit plus `pnpm docs:snapshots` is enough to publish the updated diagram.

const parsed = parseSpatial(architectureRaw)
if (!parsed.ok) {
  throw new Error(`architecture.canvas failed to parse: ${parsed.error.message}`)
}
const scene = parsed.value

afterEach(() => {
  cleanup()
})

describe('docs snapshot — architecture diagram', () => {
  it('writes docs/assets/architecture.png', async () => {
    // Load the real Roboto face before rendering so the screenshot reflects
    // production text metrics, never jsdom-style fallback measurements.
    await ensureViewerFontLoaded()

    const { container } = render(
      <CanvasViewer
        canvas={scene}
        width={1100}
        height={620}
        padding={40}
        background="#ffffff"
        testId="architecture-scene"
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

    const target = container.querySelector('[data-testid="architecture-scene"]')
    if (!(target instanceof HTMLElement)) throw new Error('viewer wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('architecture.png'),
      element: page.elementLocator(target),
    })
  })
})
