import { CanvasViewer, ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, it } from 'vitest'
import { captureDocAsset, waitForSnapshotContent } from './_helpers.js'
import { ARCHITECTURE_SCENE } from './_scenes.js'

// Generates docs/assets/architecture.png by rendering the canonical
// architecture.canvas JSON Canvas source. The .canvas file is the source of
// truth — re-running this test re-renders it deterministically so a scene
// edit plus `pnpm docs:snapshots` is enough to publish the updated diagram.

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
        canvas={ARCHITECTURE_SCENE}
        width={1100}
        height={620}
        padding={40}
        background="#ffffff"
        testId="architecture-scene"
      />,
    )

    await waitForSnapshotContent(container, { sceneText: 'Whiteboard' })
    await captureDocAsset(container, 'architecture-scene', 'architecture.png')
  })
})
