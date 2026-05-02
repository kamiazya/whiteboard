import { describe, it, beforeEach, afterEach, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import '../index.css'
import IndexPage from '../pages/IndexPage.js'
import { jsonResponse, makeFetchMock, resolveDocAssetPath } from './_helpers.js'

// Generates docs/assets/workspace-list.png — the index page with two
// workspaces and a small canvas roster, used in README and workspace docs.

// Fixed reference time so canvas updatedAt values render consistent
// "Xd ago" labels regardless of when the snapshot is regenerated. The
// canvas dates below are picked relative to this anchor.
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
            // 1d, 2d, 5d ago relative to NOW (2026-05-02T12:00Z) so the
            // rendered labels stay stable across regenerations.
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
      // Pre-rename state: no display names set yet, no canvas pinned.
      // The companion workspace-list-renamed test seeds the rename-applied
      // half so the two images form a coherent before / after pair.
      if (url === '/api/workspaces/ws_main/names') {
        return jsonResponse({ workspace: null, canvases: {}, pinned: [] })
      }
      if (url === '/api/workspaces/ws_sketches/names') {
        return jsonResponse({ workspace: null, canvases: {}, pinned: [] })
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

describe('docs snapshot — workspace list', () => {
  it('writes docs/assets/workspace-list.png', async () => {
    render(
      <MemoryRouter>
        <div className="min-h-screen w-full bg-background p-6">
          <IndexPage />
        </div>
      </MemoryRouter>,
    )

    // Wait for the canvas list to settle; the screenshot we want is the
    // post-network-fetch render where display names + pin states are
    // already applied.
    await waitFor(() => {
      const link = document.querySelector('a[href*="ws_main"]')
      if (!link) throw new Error('canvas list not yet rendered')
    })

    await page.screenshot({ path: resolveDocAssetPath('workspace-list.png') })
  })
})
