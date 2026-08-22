import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
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

// Generates docs/assets/canvas-user-annotated.png — same architecture scene
// as canvas-agent-drew, plus a red review annotation (a text node + an
// edge) the user added. Demonstrates the "human-in-the-loop" review pass
// over an agent's drawing.

const scene: SpatialCanvas = {
  nodes: [
    ...ARCHITECTURE_SCENE.nodes,
    {
      id: 'review-note',
      type: 'text',
      x: 300,
      y: 40,
      width: 220,
      height: 80,
      color: '1',
      text: 'review me:\ntighten boundary?',
    },
  ],
  edges: [
    ...ARCHITECTURE_SCENE.edges,
    {
      id: 'review-note-to-plugin-group',
      fromNode: 'review-note',
      toNode: 'plugin-group',
      toEnd: 'arrow',
      color: '1',
    },
  ],
}

// Anchor every relative timestamp the TopBar might render so the labels
// are stable across regenerations.
const NOW = new Date('2026-05-02T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  vi.stubGlobal('fetch', vi.fn(makeFetchMock(topBarFetchHandler({ dirty: true }))))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  cleanup()
})

describe('docs snapshot — user added review notes', () => {
  it('writes docs/assets/canvas-user-annotated.png', async () => {
    await ensureViewerFontLoaded()

    const { container } = render(
      <TopBarFrame testId="canvas-user-annotated-frame" width={1100} height={640} scene={scene} />,
    )

    await waitForSnapshotContent(container, {
      sceneText: 'tighten',
      topBarWorkspaceName: 'Main workspace',
    })
    await captureDocAsset(container, 'canvas-user-annotated-frame', 'canvas-user-annotated.png')
  })
})
