import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import '../index.css'
import {
  captureDocAsset,
  jsonResponse,
  makeFetchMock,
  topBarFetchHandler,
  waitForSnapshotContent,
} from './_helpers.js'
import { ARCHITECTURE_SCENE } from './_scenes.js'
import { TopBarFrame } from './_top-bar-frame.js'

// Generates docs/assets/canvas-browser-ui.png — README hero. Shows the
// full canvas chrome (workspace + canvas selector top bar, the spatial
// spatial viewport with a populated diagram) so a reader sees what the
// running app looks like with content. The diagram comes from the
// canonical architecture.canvas scene file.

// Anchor every relative timestamp the TopBar might render so the labels
// are stable across regenerations.
const NOW = new Date('2026-05-02T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)

  const topBar = topBarFetchHandler({ dirty: false })
  const fetchMock = vi.fn(
    makeFetchMock((url, init) => {
      // This card renders the multi-canvas selector, which also asks for the
      // version list; an empty list keeps the chrome free of version badges.
      if (url.includes('/documents/') && url.endsWith('/versions')) {
        return jsonResponse({ versions: [] })
      }
      return topBar(url, init)
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
})

describe('docs snapshot — canvas browser UI hero', () => {
  it('writes docs/assets/canvas-browser-ui.png', async () => {
    await ensureViewerFontLoaded()

    const { container } = render(
      <TopBarFrame
        testId="canvas-browser-ui-frame"
        width={1280}
        height={760}
        scene={ARCHITECTURE_SCENE}
      />,
    )

    await waitForSnapshotContent(container, {
      sceneText: 'Whiteboard',
      topBarTitle: 'System architecture',
    })
    await captureDocAsset(container, 'canvas-browser-ui-frame', 'canvas-browser-ui.png')
  })
})
