import architectureRaw from '@docs-assets/architecture.canvas?raw'
import { parseSpatial } from '@kamiazya/whiteboard-canvas-codec'
import { CanvasViewer, ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import '../index.css'
import { jsonResponse, makeFetchMock, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/canvas-browser-ui.png — README hero. Shows the
// full canvas chrome (workspace + canvas selector top bar, the OpenCanvas
// spatial viewport with a populated diagram) so a reader sees what the
// running app looks like with content. The diagram comes from the
// canonical architecture.canvas scene file.

const parsed = parseSpatial(architectureRaw)
if (!parsed.ok) {
  throw new Error(`architecture.canvas failed to parse: ${parsed.error.message}`)
}
const scene = parsed.value

// Anchor every relative timestamp the TopBar might render so the labels
// are stable across regenerations.
const NOW = new Date('2026-05-02T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)

  const fetchMock = vi.fn(
    makeFetchMock((url, init) => {
      if (url.endsWith('/names') && (!init || init.method === 'GET' || !init.method)) {
        return jsonResponse({
          workspace: 'Main workspace',
          canvases: { 'design/architecture': 'System architecture' },
          pinned: [],
        })
      }
      if (url.endsWith('/dirty')) {
        return jsonResponse({ dirty: false })
      }
      if (
        url.includes('/canvases/') &&
        url.endsWith('/versions') &&
        (!init || init.method === 'GET')
      ) {
        return jsonResponse({ versions: [] })
      }
      if (url.endsWith('/branches')) {
        return jsonResponse({ head: 'main', branches: [{ name: 'main' }] })
      }
      // Catch-all for any unrelated TopBar fetches; return empty arrays so
      // they don't surface error states in the UI.
      if (init?.method && init.method !== 'GET') {
        return jsonResponse({})
      }
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

describe('docs snapshot — canvas browser UI hero', () => {
  it('writes docs/assets/canvas-browser-ui.png', async () => {
    await ensureViewerFontLoaded()

    const { container } = render(
      <div
        data-testid="canvas-browser-ui-frame"
        style={{ width: '1280px', height: '760px', background: '#ffffff' }}
      >
        <WorkspaceTopBar
          workspaceId="ws_main"
          slug="design/architecture"
          canvases={[
            { slug: 'design/architecture', updatedAt: '2026-05-01T12:00:00.000Z' },
            { slug: 'design/login-flow', updatedAt: '2026-04-30T12:00:00.000Z' },
            { slug: 'sketches/inbox', updatedAt: '2026-04-29T12:00:00.000Z' },
          ]}
          onNavigateToCanvas={() => undefined}
          onEnterFullscreen={() => undefined}
          theme="light"
          onToggleTheme={() => undefined}
        />
        <div style={{ height: 'calc(100% - 48px)' }}>
          <CanvasViewer canvas={scene} width={1280} height={712} background="#ffffff" />
        </div>
      </div>,
    )

    // Wait for the TopBar's mocked display-name fetch, its
    // HeaderBranchChip's separate /branches fetch, AND the scene svg to
    // all settle. These are independent async chains — waiting on the
    // display name alone lets the branch chip's later-settling text shift
    // the top bar layout after the screenshot is taken, producing a
    // byte-unstable capture across regenerations.
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

    const target = container.querySelector('[data-testid="canvas-browser-ui-frame"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('canvas-browser-ui.png'),
      element: page.elementLocator(target),
    })
  })
})
