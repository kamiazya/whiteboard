import architectureRaw from '@docs-assets/architecture.excalidraw?raw'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, it } from 'vitest'
import { page } from 'vitest/browser'
import { resolveDocAssetPath } from './_helpers.js'
import { ScenePreview } from './_scene-preview.js'

// Generates docs/assets/canvas-presentation.png — the same architecture
// scene rendered fullscreen-style (no chrome, larger viewport) so the
// README's "fullscreen presentation mode" card matches what the actual
// Excalidraw fullscreen route shows.

interface Scene {
  elements: unknown[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
}

const scene: Scene = JSON.parse(architectureRaw)

afterEach(() => {
  cleanup()
})

describe('docs snapshot — canvas presentation mode', () => {
  it('writes docs/assets/canvas-presentation.png', async () => {
    const { container } = render(
      <ScenePreview
        width={1280}
        height={760}
        elements={scene.elements}
        appState={scene.appState}
        files={scene.files}
        hideChrome
        testId="canvas-presentation-scene"
      />,
    )

    await waitFor(() => {
      const canvas = container.querySelector('canvas')
      if (!canvas) throw new Error('Excalidraw canvas not yet mounted')
      if (canvas.width === 0) throw new Error('Excalidraw canvas not yet sized')
    })
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))

    const target = container.querySelector('[data-testid="canvas-presentation-scene"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('canvas-presentation.png'),
      element: page.elementLocator(target),
    })
  })
})
