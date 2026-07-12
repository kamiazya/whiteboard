import { describe, it, afterEach } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render, waitFor } from '@testing-library/react'
import architectureRaw from '@docs-assets/architecture.excalidraw?raw'
import { ScenePreview } from './_scene-preview.js'
import { resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/architecture.png by rendering the canonical
// architecture.excalidraw scene file. The .excalidraw is the source of
// truth — re-running this test re-rasterises it deterministically so a
// scene edit in the canvas tab plus `pnpm docs:snapshots` is enough to
// publish the updated diagram.

interface Scene {
  elements: unknown[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
}

const scene: Scene = JSON.parse(architectureRaw)

afterEach(() => {
  cleanup()
})

describe('docs snapshot — architecture diagram', () => {
  it('writes docs/assets/architecture.png', async () => {
    const { container } = render(
      <ScenePreview
        width={1100}
        height={620}
        elements={scene.elements}
        appState={scene.appState}
        files={scene.files}
        hideChrome
        testId="architecture-scene"
      />,
    )

    // Wait for Excalidraw to render its <canvas> elements. Excalidraw
    // mounts multiple stacked canvases (interactive, static, etc.); we
    // just need at least one to exist and have a non-zero size.
    await waitFor(() => {
      const canvas = container.querySelector('canvas')
      if (!canvas) throw new Error('Excalidraw canvas not yet mounted')
      if (canvas.width === 0) throw new Error('Excalidraw canvas not yet sized')
    })
    // Give Excalidraw an extra paint tick so the rasterised content has
    // settled before we screenshot.
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))

    const target = container.querySelector('[data-testid="architecture-scene"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('architecture.png'),
      element: page.elementLocator(target),
    })
  })
})
