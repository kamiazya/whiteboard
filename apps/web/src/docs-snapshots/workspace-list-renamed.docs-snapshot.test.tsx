import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render, waitFor } from '@testing-library/react'
import { DaemonIndexPage } from '../pages/DaemonIndexPage.js'
import '../index.css'
import { jsonResponse, makeFetchMock, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/workspace-list-renamed.png — companion to
// workspace-list.png. Same dataset, but with display names + a pinned
// canvas set, so the cards show friendly titles ("Auth signup flow")
// above the raw slug instead of the slug alone.

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
      const cards = container.querySelectorAll('[data-testid="daemon-index-canvas-card"]')
      if (cards.length !== 3) throw new Error('canvas grid not yet rendered')
    })

    const target = container.querySelector('[data-testid="workspace-list-renamed-frame"]')
    if (!(target instanceof HTMLElement)) throw new Error('preview wrapper not found')

    await page.screenshot({
      path: resolveDocAssetPath('workspace-list-renamed.png'),
      element: page.elementLocator(target),
    })
  })
})
