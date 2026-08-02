import authFlowRaw from '@docs-assets/canvas-auth-flow.canvas?raw'
import { parseSpatial } from '@kamiazya/whiteboard-canvas-codec'
import { CanvasViewer, ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, it } from 'vitest'
import { page } from 'vitest/browser'
import { resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/canvas-auth-flow.png — a small auth-service request
// flow diagram: Client -> API Gateway -> Token Service -> Database, with a
// Redis Cache fan-out from Token Service. Authored as docs/assets/
// canvas-auth-flow.canvas so the source of the diagram lives alongside the
// image it produces.

const parsed = parseSpatial(authFlowRaw)
if (!parsed.ok) {
  throw new Error(`canvas-auth-flow.canvas failed to parse: ${parsed.error.message}`)
}
const scene = parsed.value

afterEach(() => {
  cleanup()
})

describe('docs snapshot — canvas auth flow diagram', () => {
  it('writes docs/assets/canvas-auth-flow.png', async () => {
    await ensureViewerFontLoaded()

    const { container } = render(
      <CanvasViewer
        canvas={scene}
        width={980}
        height={420}
        padding={40}
        background="#ffffff"
        testId="canvas-auth-flow-scene"
      />,
    )

    await waitFor(() => {
      const svgs = container.querySelectorAll('svg')
      // CanvasViewer's SVG is always the last one in document order — icon
      // svgs (WorkspaceTopBar chevrons, kebab menus, etc.) render ahead of it.
      const svg = svgs[svgs.length - 1]
      if (!svg) throw new Error('scene svg not yet mounted')
      if (!(svg.textContent ?? '').includes('Token Service')) {
        throw new Error('scene content not yet rendered')
      }
    })

    const target = container.querySelector('[data-testid="canvas-auth-flow-scene"]')
    if (!(target instanceof HTMLElement)) throw new Error('viewer wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('canvas-auth-flow.png'),
      element: page.elementLocator(target),
    })
  })
})
