import { CanvasViewer, ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, it } from 'vitest'
import { captureDocAsset, waitForSnapshotContent } from './_helpers.js'
import { AUTH_FLOW_SCENE } from './_scenes.js'

// Generates docs/assets/canvas-auth-flow.png — a small auth-service request
// flow diagram: Client -> API Gateway -> Token Service -> Database, with a
// Redis Cache fan-out from Token Service. Authored as docs/assets/
// canvas-auth-flow.canvas so the source of the diagram lives alongside the
// image it produces.

afterEach(() => {
  cleanup()
})

describe('docs snapshot — canvas auth flow diagram', () => {
  it('writes docs/assets/canvas-auth-flow.png', async () => {
    await ensureViewerFontLoaded()

    const { container } = render(
      <CanvasViewer
        canvas={AUTH_FLOW_SCENE}
        width={980}
        height={420}
        padding={40}
        background="#ffffff"
        testId="canvas-auth-flow-scene"
      />,
    )

    await waitForSnapshotContent(container, { sceneText: 'Token Service' })
    await captureDocAsset(container, 'canvas-auth-flow-scene', 'canvas-auth-flow.png')
  })
})
