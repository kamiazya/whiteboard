import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import architectureRaw from '@docs-assets/architecture.excalidraw?raw'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import '../index.css'
import { jsonResponse, makeFetchMock, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/canvas-browser-ui.png — README hero. Shows the
// full canvas chrome (workspace + canvas selector top bar, Excalidraw
// editing toolbar, viewport with a populated diagram) so a reader sees
// what the running app looks like with content. The diagram comes from
// the canonical architecture.excalidraw scene file.

interface Scene {
  elements: unknown[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
}

const scene: Scene = JSON.parse(architectureRaw)

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
      if (init && init.method && init.method !== 'GET') {
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
          <Excalidraw
            initialData={{
              elements: scene.elements as never,
              appState: {
                viewBackgroundColor: '#ffffff',
                ...((scene.appState as object | undefined) ?? {}),
              } as never,
              files: ((scene.files as object | undefined) ?? {}) as never,
              scrollToContent: true,
            }}
          />
        </div>
      </div>,
    )

    // Wait for the TopBar's mocked display-name fetch, its
    // HeaderBranchChip's separate /branches fetch, AND Excalidraw's canvas
    // to all settle. These are independent async chains — waiting on the
    // display name alone lets the branch chip's later-settling text or
    // icon shift the top bar layout after the screenshot is taken,
    // producing a byte-unstable capture across regenerations.
    await waitFor(() => {
      const titleText = container.textContent ?? ''
      if (!titleText.includes('System architecture')) {
        throw new Error('TopBar canvas display name not yet rendered')
      }
      if (!container.querySelector('[aria-label^="Switch variation"]')) {
        throw new Error('HeaderBranchChip not yet rendered')
      }
      const canvas = container.querySelector('canvas')
      if (!canvas) throw new Error('Excalidraw canvas not yet mounted')
      if (canvas.width === 0) throw new Error('Excalidraw canvas not yet sized')
    })
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    }

    const target = container.querySelector('[data-testid="canvas-browser-ui-frame"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('canvas-browser-ui.png'),
      element: page.elementLocator(target),
    })
  })
})
