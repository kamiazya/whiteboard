import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import '../index.css'
import IndexPage from '../pages/IndexPage.js'
import { jsonResponse, makeFetchMock, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/workspace-list-renamed.png — companion to
// workspace-list.png. Same dataset, but with display names set so the
// user-friendly canvas label takes precedence over the slug. Renders
// the IndexPage after a rename pass.

const NOW = new Date('2026-05-02T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)

  const fetchMock = vi.fn(
    makeFetchMock((url) => {
      if (url === '/api/workspaces') {
        return jsonResponse({ workspaces: [{ workspaceId: 'ws_main' }, { workspaceId: 'ws_sketches' }] })
      }
      if (url === '/api/workspaces/ws_main/canvases') {
        return jsonResponse({
          canvases: [
            { slug: 'design/login-flow', updatedAt: '2026-05-01T12:00:00.000Z' },
            { slug: 'design/onboarding', updatedAt: '2026-04-30T12:00:00.000Z' },
            { slug: 'architecture/overview', updatedAt: '2026-04-27T12:00:00.000Z' },
          ],
        })
      }
      if (url === '/api/workspaces/ws_sketches/canvases') {
        return jsonResponse({
          canvases: [{ slug: 'inbox', updatedAt: '2026-04-29T12:00:00.000Z' }],
        })
      }
      // The "renamed" half: every canvas has a friendly display name and
      // the workspace name itself is set, so the cards show titles like
      // "Auth signup flow" instead of the raw `design/login-flow` slug.
      if (url === '/api/workspaces/ws_main/names') {
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
      if (url === '/api/workspaces/ws_sketches/names') {
        return jsonResponse({ workspace: 'Quick sketches', canvases: { inbox: 'Today\'s inbox' }, pinned: [] })
      }
      if (url === '/api/runtime/storage') {
        return jsonResponse({
          totalBytes: 0,
          fileCount: 0,
          byCategory: {
            blobs: { bytes: 0, files: 0 },
            versions: { bytes: 0, files: 0 },
            files: { bytes: 0, files: 0 },
            libraries: { bytes: 0, files: 0 },
            db: { bytes: 0, files: 0 },
            exports: { bytes: 0, files: 0 },
            logs: { bytes: 0, files: 0 },
            other: { bytes: 0, files: 0 },
          },
          lastAutoCompactedAt: null,
        })
      }
      return undefined
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
    render(
      <MemoryRouter>
        <div className="min-h-screen w-full bg-background p-6">
          <IndexPage />
        </div>
      </MemoryRouter>,
    )

    await waitFor(() => {
      const link = document.querySelector('a[href*="ws_main"]')
      if (!link) throw new Error('canvas list not yet rendered')
    })

    await page.screenshot({ path: resolveDocAssetPath('workspace-list-renamed.png') })
  })
})
