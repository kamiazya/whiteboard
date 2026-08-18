import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import '../index.css'
import {
  captureDocAsset,
  makeFetchMock,
  topBarFetchHandler,
  waitForSnapshotContent,
} from './_helpers.js'
import { ARCHITECTURE_SCENE } from './_scenes.js'
import { TopBarFrame } from './_top-bar-frame.js'

// Generates docs/assets/canvas-agent-drew.png — the "agent drew the
// architecture diagram" card in the README's three-up canvas tour. Same
// architecture scene as canvas-browser-ui but framed slightly tighter so
// the README cards have visible composition variety.

// Anchor every relative timestamp the TopBar might render so the labels
// are stable across regenerations.
const NOW = new Date('2026-05-02T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  vi.stubGlobal('fetch', vi.fn(makeFetchMock(topBarFetchHandler({ dirty: false }))))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
})

describe('docs snapshot — agent drew the architecture diagram', () => {
  it('writes docs/assets/canvas-agent-drew.png', async () => {
    await ensureViewerFontLoaded()

    const { container } = render(
      <TopBarFrame
        testId="canvas-agent-drew-frame"
        width={1100}
        height={640}
        documents={[{ path: 'design/architecture', updatedAt: '2026-05-01T12:00:00.000Z' }]}
        scene={ARCHITECTURE_SCENE}
      />,
    )

    await waitForSnapshotContent(container, {
      sceneText: 'Whiteboard',
      topBarWorkspaceName: 'Main workspace',
    })
    await captureDocAsset(container, 'canvas-agent-drew-frame', 'canvas-agent-drew.png')
  })
})
