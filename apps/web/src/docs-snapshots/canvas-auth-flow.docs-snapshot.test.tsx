import { describe, it, afterEach } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render, waitFor } from '@testing-library/react'
import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import { ScenePreview } from './_scene-preview.js'
import { pinRandomFields, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/canvas-auth-flow.png — a small auth-service
// request flow diagram: Client → API Gateway → Token Service → Database,
// with a Redis Cache fan-out from Token Service. Authored as a skeleton
// element list so the source of the diagram lives next to the test that
// renders it.

const skeleton = [
  { type: 'rectangle', x: 60, y: 200, width: 140, height: 70, label: { text: 'Client' } },
  { type: 'rectangle', x: 280, y: 200, width: 160, height: 70, label: { text: 'API Gateway' } },
  { type: 'rectangle', x: 520, y: 200, width: 170, height: 70, label: { text: 'Token Service' } },
  { type: 'rectangle', x: 770, y: 200, width: 150, height: 70, label: { text: 'Database' } },
  {
    type: 'rectangle',
    x: 520,
    y: 70,
    width: 170,
    height: 70,
    backgroundColor: '#fff3bf',
    label: { text: 'Redis Cache' },
  },
  { type: 'arrow', x: 200, y: 235, width: 80, height: 0, label: { text: 'login' } },
  { type: 'arrow', x: 440, y: 235, width: 80, height: 0, label: { text: 'verify' } },
  { type: 'arrow', x: 690, y: 235, width: 80, height: 0, label: { text: 'fetch' } },
  // Token Service ↔ Redis Cache fan-out.
  { type: 'arrow', x: 605, y: 200, width: 0, height: -60, label: { text: 'cache hit?' } },
  { type: 'arrow', x: 605, y: 140, width: 0, height: 60, strokeStyle: 'dashed' },
] as const

afterEach(() => {
  cleanup()
})

describe('docs snapshot — canvas auth flow diagram', () => {
  it('writes docs/assets/canvas-auth-flow.png', async () => {
    // Generate inside the test, after the global setup file has installed
    // the seeded Math.random. Calling convertToExcalidrawElements at
    // module-load time would resolve random ids before the seed is
    // active, leaving the rendered PNG non-deterministic.
    const elements = pinRandomFields(
      convertToExcalidrawElements(skeleton as never) as Array<Record<string, unknown>>,
    )

    const { container } = render(
      <ScenePreview
        width={980}
        height={420}
        elements={elements}
        hideChrome
        testId="canvas-auth-flow-scene"
      />,
    )

    await waitFor(() => {
      const canvas = container.querySelector('canvas')
      if (!canvas) throw new Error('Excalidraw canvas not yet mounted')
      if (canvas.width === 0) throw new Error('Excalidraw canvas not yet sized')
    })
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))

    const target = container.querySelector('[data-testid="canvas-auth-flow-scene"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('canvas-auth-flow.png'),
      element: page.elementLocator(target),
    })
  })
})
