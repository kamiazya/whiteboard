import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { DaemonIndexPage } from '../pages/DaemonIndexPage.js'
import '../index.css'
import { jsonResponse, makeFetchMock, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/workspace-list-renamed.png — companion to
// workspace-list.png. Same dataset, but with display names + a pinned
// canvas set, so the cards show friendly titles ("Auth signup flow")
// above the raw slug instead of the slug alone.

const NOW = new Date('2026-05-02T12:00:00.000Z')

// CanvasThumb fires its own daemonFetch(.../latest-thumbnail) per card and
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
      if (url.endsWith('/api/workspaces/ws_main/canvases')) {
        return jsonResponse({
          canvases: [
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
      // The "renamed" half: every canvas has a friendly display name and a
      // pinned entry, so the cards show titles instead of the raw slug.
      if (url.endsWith('/api/workspaces/ws_main/names')) {
        return jsonResponse({
          workspace: 'Production designs',
          canvases: {
            'design/login-flow': 'Auth signup flow',
            'design/onboarding': 'New user onboarding',
            'architecture/overview': 'System architecture',
          },
          pinned: ['architecture/overview'],
        })
      }
      if (url.endsWith('/api/workspaces/ws_sketches/names')) {
        return jsonResponse({
          workspace: 'Quick sketches',
          canvases: { inbox: "Today's inbox" },
          pinned: [],
        })
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

describe('docs snapshot — workspace list (renamed)', () => {
  it('writes docs/assets/workspace-list-renamed.png', async () => {
    const { container } = render(
      <div
        data-testid="workspace-list-renamed-frame"
        style={{ width: '1100px', height: '640px', background: '#ffffff' }}
      >
        <DaemonIndexPage
          daemonBaseUrl="http://127.0.0.1:3099"
          initialWorkspaceId="ws_main"
          onOpenCanvas={() => undefined}
        />
      </div>,
    )

    await waitFor(() => {
      const titleText = container.textContent ?? ''
      if (!titleText.includes('Auth signup flow')) {
        throw new Error('renamed canvas display name not yet rendered')
      }
      const cards = container.querySelectorAll('[data-testid="canvas-list-card"]')
      if (cards.length !== 3) throw new Error('canvas grid not yet rendered')
      if (thumbnailFetchCount < 3) throw new Error('thumbnail fetches not yet started')
    })
    vi.useRealTimers()

    const target = container.querySelector('[data-testid="workspace-list-renamed-frame"]')
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
      path: resolveDocAssetPath('workspace-list-renamed.png'),
      element: page.elementLocator(clone),
    })
    clone.remove()
  })
})
