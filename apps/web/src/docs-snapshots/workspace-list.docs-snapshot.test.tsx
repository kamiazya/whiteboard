import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { DaemonIndexPage } from '../pages/DaemonIndexPage.js'
import '../index.css'
import { jsonResponse, makeFetchMock, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/workspace-list.png — the daemon canvas gallery
// (DaemonIndexPage), used in README and workspace docs.
//
// DaemonIndexPage renders ONE workspace's documents at a time (picked via
// the "Workspace" <select>), unlike the retired mcp-server IndexPage this
// image used to show, which flattened every workspace into a single list.
// A native <select>'s open dropdown is not reliably screenshot-able in
// headless Chromium, so this capture shows the selector closed on
// "ws_main" — the accompanying docs prose (not this image) is what
// communicates that the selector switches between workspaces.

const NOW = new Date('2026-05-02T12:00:00.000Z')

// DocumentThumb fires its own daemonFetch(.../latest-thumbnail) per card and
// calls setFailed(true) once the 404 response resolves. That render commit
// happens on a microtask hop AFTER this counter increments, so waitFor
// below also needs a settle tick (see the rAF loop) — counting requests
// alone only proves the fetch started, not that the resulting re-render
// and repaint have landed.
let thumbnailFetchCount = 0

beforeEach(() => {
  thumbnailFetchCount = 0
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)

  const fetchMock = vi.fn(
    makeFetchMock((url) => {
      if (url.endsWith('/api/workspaces')) {
        return jsonResponse({
          workspaces: [{ workspaceId: 'ws_main' }, { workspaceId: 'ws_sketches' }],
        })
      }
      if (url.endsWith('/api/workspaces/ws_main/documents')) {
        return jsonResponse({
          documents: [
            // 1d, 2d, 5d ago relative to NOW (2026-05-02T12:00Z) so the
            // rendered labels stay stable across regenerations.
            { path: 'design/login-flow', updatedAt: '2026-05-01T12:00:00.000Z' },
            { path: 'design/onboarding', updatedAt: '2026-04-30T12:00:00.000Z' },
            { path: 'architecture/overview', updatedAt: '2026-04-27T12:00:00.000Z' },
          ],
        })
      }
      if (url.endsWith('/api/workspaces/ws_sketches/documents')) {
        return jsonResponse({
          documents: [{ path: 'inbox', updatedAt: '2026-04-29T12:00:00.000Z' }],
        })
      }
      // Pre-rename state: no display names set yet, no canvas pinned. The
      // companion workspace-list-renamed test seeds the rename-applied
      // half so the two images form a coherent before / after pair.
      if (url.endsWith('/names')) {
        return jsonResponse({ workspace: null, documents: {}, pinned: [] })
      }
      if (url.includes('/latest-thumbnail')) {
        thumbnailFetchCount += 1
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
      <MemoryRouter initialEntries={['/']}>
        <div
          data-testid="workspace-list-frame"
          style={{ width: '1100px', height: '640px', background: '#ffffff' }}
        >
          <DaemonIndexPage
            daemonBaseUrl="http://127.0.0.1:3099"
            initialWorkspaceId="ws_main"
            onOpenDocument={() => undefined}
          />
        </div>
      </MemoryRouter>,
    )

    // Wait for all 3 of ws_main's canvas cards to settle (proves the
    // documents + names fetches both resolved) AND for each card's
    // DocumentThumb to have fired its own latest-thumbnail fetch.
    await waitFor(() => {
      const cards = container.querySelectorAll('[data-testid="document-list-card"]')
      if (cards.length !== 3) throw new Error('canvas grid not yet rendered')
      if (thumbnailFetchCount < 3) throw new Error('thumbnail fetches not yet started')
    })
    vi.useRealTimers()

    const target = container.querySelector('[data-testid="workspace-list-frame"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')

    // The settled DOM is byte-identical run to run (confirmed by comparing
    // outerHTML dumps across regenerations), yet the rendered pixels still
    // flip between two states. DaemonIndexPage settles through several
    // re-renders (empty -> workspace selected -> rows populated), and
    // Chromium's incremental layout/paint can converge to a slightly
    // different sub-pixel rounding than a single fresh layout of the same
    // final markup would — a rendering-history artifact, not a DOM
    // difference. Re-inserting a clone into a detached subtree forces a
    // fresh layout+paint from scratch, matching the byte-stable behavior a
    // statically-rendered version of this same markup already has.
    const clone = target.cloneNode(true) as HTMLElement
    clone.style.position = 'fixed'
    clone.style.top = '0'
    clone.style.left = '0'
    document.body.appendChild(clone)
    target.style.display = 'none'
    void clone.offsetHeight
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)))
    }

    await page.screenshot({
      path: resolveDocAssetPath('workspace-list.png'),
      element: page.elementLocator(clone),
    })
    clone.remove()
  })
})
