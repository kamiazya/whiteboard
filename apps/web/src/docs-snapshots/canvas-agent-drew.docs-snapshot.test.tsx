import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import architectureRaw from '@docs-assets/architecture.excalidraw?raw'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import '../index.css'
import { jsonResponse, makeFetchMock, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/canvas-agent-drew.png — the "agent drew the
// architecture diagram" card in the README's three-up canvas tour.
// Same architecture scene as canvas-browser-ui but framed slightly
// tighter so the README cards have visible composition variety.

interface Scene {
  elements: unknown[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
}

const scene: Scene = JSON.parse(architectureRaw)
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

    // Wait until the TopBar's mocked /names fetch has resolved (display
    // name swapped in for the slug), its HeaderBranchChip has resolved its
    // own separate /branches fetch, AND the Excalidraw canvas has
    // rendered. These are three independent async chains — waiting on the
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
    // Give Excalidraw a few more paint ticks so any post-init re-render
    // (font metric callbacks, useLayoutEffect chains) settles.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    }

    const target = container.querySelector('[data-testid="canvas-agent-drew-frame"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')
    // Force a fresh layout + repaint pass. Toggling display off/on (rather
    // than cloning) preserves the Excalidraw <canvas>'s rasterised bitmap,
    // which a cloneNode would silently wipe.
    target.style.display = 'none'
    void target.offsetHeight
    target.style.display = ''
    void target.offsetHeight
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    }

    await page.screenshot({
      path: resolveDocAssetPath('canvas-agent-drew.png'),
      element: page.elementLocator(target),
    })
  })
})
