import architectureRaw from '@docs-assets/architecture.canvas?raw'
import { parseSpatial } from '@kamiazya/whiteboard-canvas-codec'
import { CanvasViewer, ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import '../index.css'
import { jsonResponse, makeFetchMock, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/canvas-agent-drew.png — the "agent drew the
// architecture diagram" card in the README's three-up canvas tour. Same
// architecture scene as canvas-browser-ui but framed slightly tighter so
// the README cards have visible composition variety.

const parsed = parseSpatial(architectureRaw)
if (!parsed.ok) {
  throw new Error(`architecture.canvas failed to parse: ${parsed.error.message}`)
}
const scene = parsed.value
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
      if (url.endsWith('/dirty')) return jsonResponse({ dirty: false })
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

describe('docs snapshot — agent drew the architecture diagram', () => {
  it('writes docs/assets/canvas-agent-drew.png', async () => {
    await ensureViewerFontLoaded()

    const { container } = render(
      <div
        data-testid="canvas-agent-drew-frame"
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

    // Wait until the TopBar's mocked /names fetch has resolved (display
    // name swapped in for the slug), its HeaderBranchChip has resolved its
    // own separate /branches fetch, AND the scene svg has rendered. These
    // are independent async chains — waiting on the display name alone
    // lets the branch chip's later-settling text shift the top bar layout
    // after the screenshot is taken, producing a byte-unstable capture.
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
      if (!svg || !(svg.textContent ?? '').includes('Whiteboard')) {
        throw new Error('scene content not yet rendered')
      }
    })

    const target = container.querySelector('[data-testid="canvas-agent-drew-frame"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('canvas-agent-drew.png'),
      element: page.elementLocator(target),
    })
  })
})
