// Real-browser lock for the read-only viewer contract: jsdom mocks Excalidraw
// away entirely (see CanvasViewer.test.tsx), so it cannot prove the actual
// <Excalidraw> render produces a live <canvas> the user can pan/zoom/select
// on. This is the nearest-layer real-browser test for that claim.
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CanvasViewer } from './CanvasViewer.js'
import type { ViewerScene } from './scene.js'

const scene: ViewerScene = {
  elements: [
    {
      id: 'rect-1',
      type: 'rectangle',
      x: 10,
      y: 10,
      width: 100,
      height: 80,
      angle: 0,
      strokeColor: '#000000',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
    },
  ] as never,
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
}

describe('CanvasViewer (real browser)', () => {
  it('renders a live canvas element for the scene', async () => {
    const { container } = render(<CanvasViewer scene={scene} width={400} height={300} />)

    await expect.poll(() => container.querySelector('canvas'), { timeout: 5000 }).toBeTruthy()
  })

  it('hides the editing menu chrome and keeps the canvas visible', async () => {
    const { container } = render(
      <CanvasViewer scene={scene} width={400} height={300} hideChrome testId="ro-viewer" />,
    )

    await expect.poll(() => container.querySelector('canvas'), { timeout: 5000 }).toBeTruthy()

    // .App-menu is desktop-only chrome: at this test's viewport size
    // Excalidraw renders its `excalidraw--mobile` layout instead, which
    // never mounts .App-menu at all (regardless of hideChrome). .App-bottom-bar
    // is the chrome node that's actually present at both breakpoints, so it's
    // the one that can prove the hideChrome CSS contract instead of passing
    // vacuously when the desktop-only node is absent.
    await expect
      .poll(() => container.querySelector('.App-bottom-bar'), { timeout: 5000 })
      .toBeTruthy()
    const bottomBar = container.querySelector('.App-bottom-bar')
    expect(bottomBar).toBeTruthy()
    expect(getComputedStyle(bottomBar as Element).display).toBe('none')
  })
})
