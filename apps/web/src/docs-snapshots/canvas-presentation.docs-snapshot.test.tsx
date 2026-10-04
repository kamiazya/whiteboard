import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, it } from 'vitest'
import { captureDocAsset, waitForSnapshotContent } from './_helpers.js'
import { LegendlessCanvas } from './_legendless-canvas.js'
import { ARCHITECTURE_SCENE } from './_scenes.js'

// Generates docs/assets/canvas-presentation.png — the same architecture
// scene rendered chrome-free at a larger viewport, suitable for embedding
// in docs. This is a plain canvas render, not a capture of the app — see
// the README caption this image backs.

afterEach(() => {
  cleanup()
})

describe('docs snapshot — canvas presentation render', () => {
  it('writes docs/assets/canvas-presentation.png', async () => {
    await ensureViewerFontLoaded()

    const { container } = render(
      <LegendlessCanvas
        canvas={ARCHITECTURE_SCENE}
        width={1280}
        height={760}
        padding={60}
        testId="canvas-presentation-scene"
      />,
    )

    await waitForSnapshotContent(container, { sceneText: 'Whiteboard' })
    await captureDocAsset(container, 'canvas-presentation-scene', 'canvas-presentation.png')
  })
})
