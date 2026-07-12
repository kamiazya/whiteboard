import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render, waitFor } from '@testing-library/react'
import { DaemonIndexPage } from '../pages/DaemonIndexPage.js'
import '../index.css'
import { jsonResponse, makeFetchMock, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/workspace-list.png — the daemon canvas gallery
// (DaemonIndexPage), used in README and workspace docs.
//
// DaemonIndexPage renders ONE workspace's canvases at a time (picked via
// the "Workspace" <select>), unlike the retired mcp-server IndexPage this
// image used to show, which flattened every workspace into a single list.
// A native <select>'s open dropdown is not reliably screenshot-able in
// headless Chromium, so this capture shows the selector closed on
// "ws_main" — the accompanying docs prose (not this image) is what
// communicates that the selector switches between workspaces.

const NOW = new Date('2026-05-02T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)

  const fetchMock = vi.fn(
    makeFetchMock((url) => {
      if (url.endsWith('/api/workspaces')) {
        return jsonResponse({
          workspaces: [{ workspaceId: 'ws_main' }, { workspaceId: 'ws_sketches' }],
        })
      }
      if (url.endsWith('/api/workspaces/ws_main/canvases')) {
        return jsonResponse({
          canvases: [
            // 1d, 2d, 5d ago relative to NOW (2026-05-02T12:00Z) so the
            // rendered labels stay stable across regenerations.
            { slug: 'design/login-flow', updatedAt: '2026-05-01T12:00:00.000Z' },
            { slug: 'design/onboarding', updatedAt: '2026-04-30T12:00:00.000Z' },
            { slug: 'architecture/overview', updatedAt: '2026-04-27T12:00:00.000Z' },
          ],
        })
      }
      if (url.endsWith('/api/workspaces/ws_sketches/canvases')) {
        return jsonResponse({
          canvases: [{ slug: 'inbox', updatedAt: '2026-04-29T12:00:00.000Z' }],
        })
      }
      // Pre-rename state: no display names set yet, no canvas pinned. The
      // companion workspace-list-renamed test seeds the rename-applied
      // half so the two images form a coherent before / after pair.
      if (url.endsWith('/names')) {
        return jsonResponse({ workspace: null, canvases: {}, pinned: [] })
      }
      if (url.includes('/latest-thumbnail')) {
        return new Response(null, { status: 404 })
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

describe('docs snapshot — workspace list', () => {
  it('writes docs/assets/workspace-list.png', async () => {
    const { container } = render(
      <div
        data-testid="workspace-list-frame"
        style={{ width: '1100px', height: '640px', background: '#ffffff' }}
      >
        <DaemonIndexPage
          daemonBaseUrl="http://127.0.0.1:3099"
          initialWorkspaceId="ws_main"
          onOpenCanvas={() => undefined}
        />
      </div>,
    )

    // Wait for all 3 of ws_main's canvas cards to settle (proves the
    // canvases + names fetches both resolved) before capturing.
    await waitFor(() => {
      const cards = container.querySelectorAll('[data-testid="daemon-index-canvas-card"]')
      if (cards.length !== 3) throw new Error('canvas grid not yet rendered')
    })

    const target = container.querySelector('[data-testid="workspace-list-frame"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('workspace-list.png'),
      element: page.elementLocator(target),
    })
  })
})
