import architectureRaw from '@docs-assets/architecture.canvas?raw'
import { parseSpatial } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { CanvasViewer, ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import '../index.css'
import { jsonResponse, makeFetchMock, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/canvas-user-annotated.png — same architecture scene
// as canvas-agent-drew, plus a red review annotation (a text node + an
// edge) the user added. Demonstrates the "human-in-the-loop" review pass
// over an agent's drawing.

const parsedArchitecture = parseSpatial(architectureRaw)
if (!parsedArchitecture.ok) {
  throw new Error(`architecture.canvas failed to parse: ${parsedArchitecture.error.message}`)
}

const scene: SpatialCanvas = {
  nodes: [
    ...parsedArchitecture.value.nodes,
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
    ...parsedArchitecture.value.edges,
    {
      id: 'review-note-to-plugin-group',
      fromNode: 'review-note',
      toNode: 'plugin-group',
      toEnd: 'arrow',
      color: '1',
    },
  ],
}

const NOW = new Date('2026-05-02T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  const fetchMock = vi.fn(
    makeFetchMock((url) => {
      if (url.endsWith('/names')) {
        return jsonResponse({
          workspace: 'Main workspace',
          canvases: { 'design/architecture': 'System architecture' },
          pinned: [],
        })
      }
      if (url.endsWith('/dirty')) return jsonResponse({ dirty: true })
      if (url.endsWith('/branches'))
        return jsonResponse({ head: 'main', branches: [{ name: 'main' }] })
      return jsonResponse({})
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
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
      <div
        data-testid="canvas-user-annotated-frame"
        style={{ width: '1100px', height: '640px', background: '#ffffff' }}
      >
        <WorkspaceTopBar
          workspaceId="ws_main"
          slug="design/architecture"
          canvases={[{ slug: 'design/architecture', updatedAt: '2026-05-01T12:00:00.000Z' }]}
          onNavigateToCanvas={() => undefined}
          onEnterFullscreen={() => undefined}
          theme="light"
          onToggleTheme={() => undefined}
        />
        <div style={{ height: 'calc(100% - 48px)' }}>
          <CanvasViewer canvas={scene} width={1100} height={592} background="#ffffff" />
        </div>
      </div>,
    )

    await waitFor(() => {
      const titleText = container.textContent ?? ''
      if (!titleText.includes('System architecture')) {
        throw new Error('TopBar canvas display name not yet rendered')
      }
      if (!container.querySelector('[aria-label^="Switch variation"]')) {
        throw new Error('HeaderBranchChip not yet rendered')
      }
      const svgs = container.querySelectorAll('svg')
      // CanvasViewer's SVG is always the last one in document order — icon
      // svgs (WorkspaceTopBar chevrons, kebab menus, etc.) render ahead of it.
      const svg = svgs[svgs.length - 1]
      if (!svg || !(svg.textContent ?? '').includes('tighten')) {
        throw new Error('scene content not yet rendered')
      }
    })

    const target = container.querySelector('[data-testid="canvas-user-annotated-frame"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('canvas-user-annotated.png'),
      element: page.elementLocator(target),
    })
  })
})
