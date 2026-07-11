import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { STATUS_CLEAR_MS, StorageReportCard } from './StorageReportCard.js'

const PAYLOAD = {
  totalBytes: 4096,
  fileCount: 6,
  byCategory: {
    blobs: { bytes: 1024, files: 2 },
    versions: { bytes: 2048, files: 1 },
    files: { bytes: 0, files: 0 },
    libraries: { bytes: 0, files: 0 },
    db: { bytes: 1024, files: 1 },
    other: { bytes: 0, files: 2 },
  },
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

// Simulate Vitest tearing the jsdom environment down (as it does once a test
// file finishes) while a component-scheduled timer is still pending, then
// restore `window`. React 19 silently no-ops a setState on an unmounted root
// under a *live* jsdom window; the crash only reproduces once `window` itself
// is gone by the time the timer fires — dispatchSetState then touches the
// now-undefined `window` and throws "ReferenceError: window is not defined".
// If waitForPendingTimer throws, it propagates and fails the test.
async function withWindowTornDown(waitForPendingTimer: () => Promise<unknown>): Promise<void> {
  const savedWindow = (globalThis as { window?: unknown }).window
  delete (globalThis as { window?: unknown }).window
  try {
    await waitForPendingTimer()
  } finally {
    ;(globalThis as { window?: unknown }).window = savedWindow
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-01T00:00:00Z'))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(PAYLOAD), { status: 200 }))),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('StorageReportCard', () => {
  it('renders each storage category as its own row so future actions can hang off objects', async () => {
    const { container } = render(<StorageReportCard />)
    // Eight rows render synchronously from the static descriptor list:
    // blobs, versions, files, exports, logs, db, other, libraries.
    // Values fill in once fetch + the min-refresh timer settle.
    expect(container.querySelectorAll('[data-storage-row]').length).toBe(8)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const versionsRow = container.querySelector('[data-storage-row="versions"]')
    expect(versionsRow).not.toBeNull()
    expect(versionsRow!.textContent).toContain('Versions')
    expect(versionsRow!.textContent).toMatch(/2\.0\s*KiB|2048/)
    // Reserved per-row action slot is the OOUI hook for future Optimize.
    expect(container.querySelector('[data-storage-actions="versions"]')).not.toBeNull()
    // User libraries row is pinned to the bottom so management UI lives
    // away from the hot maintenance buckets.
    const allRows = Array.from(container.querySelectorAll('[data-storage-row]'))
    expect(allRows[allRows.length - 1]?.getAttribute('data-storage-row')).toBe('libraries')
  })

  it('exposes Optimize all on the Canvas snapshots row and aggregates across workspaces', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/runtime/storage') {
        return Promise.resolve(jsonResponse(PAYLOAD))
      }
      if (url === '/api/workspaces') {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws_a' }, { workspaceId: 'ws_b' }] }),
        )
      }
      if (init?.method === 'POST' && url.endsWith('/canvases/optimize-all')) {
        return Promise.resolve(
          jsonResponse({
            results: [],
            totalBeforeBytes: url.includes('ws_a') ? 4000 : 1500,
            totalAfterBytes: url.includes('ws_a') ? 1000 : 1000,
          }),
        )
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    // Use real timers for this test — the optimize handler chains many
    // awaits (workspaces fetch → per-workspace POSTs → implicit refresh)
    // and threading them through fake timers without wedging Promise
    // microtasks is not worth the test complexity.
    vi.useRealTimers()

    const { container } = render(<StorageReportCard />)
    await waitFor(() => {
      expect(container.querySelector('[data-storage-row="blobs"]')).not.toBeNull()
    })

    // The Optimize action lives on the Canvas snapshots row — the object
    // it acts on. Locate it via the reserved actions slot.
    const blobsActions = container.querySelector('[data-storage-actions="blobs"]')
    expect(blobsActions).not.toBeNull()
    const button = blobsActions!.querySelector('button')
    expect(button).not.toBeNull()
    fireEvent.click(button!)

    // Both workspaces must be hit, in either order.
    await waitFor(() => {
      const optimizeUrls = fetchMock.mock.calls
        .map(([u, i]) => ({
          u: typeof u === 'string' ? u : u instanceof URL ? u.toString() : (u as Request).url,
          method: (i as RequestInit | undefined)?.method,
        }))
        .filter((c) => c.method === 'POST' && c.u.endsWith('/canvases/optimize-all'))
        .map((c) => c.u)
        .sort()
      expect(optimizeUrls).toEqual([
        '/api/workspaces/ws_a/canvases/optimize-all',
        '/api/workspaces/ws_b/canvases/optimize-all',
      ])
    })

    // Status string lands on the row after the action settles.
    await waitFor(() => {
      expect(blobsActions!.textContent ?? '').toMatch(/saved|optimal|optimi/i)
    })
  })

  it('exposes Cleanup on the Uploaded files row and aggregates dangling-file purges across workspaces', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/runtime/storage') {
        return Promise.resolve(jsonResponse(PAYLOAD))
      }
      if (url === '/api/workspaces') {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws_a' }, { workspaceId: 'ws_b' }] }),
        )
      }
      if (init?.method === 'POST' && url.endsWith('/files/purge-dangling')) {
        return Promise.resolve(
          jsonResponse({
            purgedCount: url.includes('ws_a') ? 3 : 1,
            purgedBytes: url.includes('ws_a') ? 6000 : 2000,
          }),
        )
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    vi.useRealTimers()
    const { container } = render(<StorageReportCard />)
    await waitFor(() => {
      expect(container.querySelector('[data-storage-row="files"]')).not.toBeNull()
    })

    const filesActions = container.querySelector('[data-storage-actions="files"]')
    expect(filesActions).not.toBeNull()
    const button = filesActions!.querySelector('button')
    expect(button).not.toBeNull()
    fireEvent.click(button!)

    await waitFor(() => {
      const purgeUrls = fetchMock.mock.calls
        .map(([u, i]) => ({
          u: typeof u === 'string' ? u : u instanceof URL ? u.toString() : (u as Request).url,
          method: (i as RequestInit | undefined)?.method,
        }))
        .filter((c) => c.method === 'POST' && c.u.endsWith('/files/purge-dangling'))
        .map((c) => c.u)
        .sort()
      expect(purgeUrls).toEqual([
        '/api/workspaces/ws_a/files/purge-dangling',
        '/api/workspaces/ws_b/files/purge-dangling',
      ])
    })

    await waitFor(() => {
      // 3+1 files removed, 6000+2000 bytes — the row's transient status
      // should reflect a non-zero summary (we do not pin the exact byte
      // formatting since formatBytes may pick KiB / MiB depending on size).
      expect(filesActions!.textContent ?? '').toMatch(/Removed\s+4/i)
    })
  })

  it('does not call setState after unmount while the min-refresh delay is still pending', async () => {
    const { unmount } = render(<StorageReportCard />)
    // Unmount while the initial mount-time refresh() is still awaiting its
    // fetch response and MIN_REFRESH_MS floor — this is the timing window
    // that let a post-unmount setLoading(false) fire during jsdom teardown.
    unmount()
    // Tear down `window` while refresh()'s pending setTimeout is still
    // scheduled — the CI crash reproduces only once `window` is gone.
    await withWindowTornDown(() => vi.advanceTimersByTimeAsync(500))
  })

  it('clears the pending min-refresh-delay timer on unmount instead of leaking it', async () => {
    const { unmount } = render(<StorageReportCard />)
    // The initial mount-time refresh() has an in-flight MIN_REFRESH_MS
    // setTimeout at this point.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it(
    'does not call setState after unmount while the optimizeAll status-clear timer is still pending',
    async () => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url === '/api/runtime/storage') {
          return Promise.resolve(jsonResponse(PAYLOAD))
        }
        if (url === '/api/workspaces') {
          return Promise.resolve(jsonResponse({ workspaces: [] }))
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      })

      // Real timers — optimizeAll's own fetch chain must actually settle
      // before its finally-block schedules the STATUS_CLEAR_MS timer that
      // this test unmounts underneath.
      vi.useRealTimers()

      const { container, unmount } = render(<StorageReportCard />)
      await waitFor(() => {
        expect(container.querySelector('[data-storage-row="blobs"]')).not.toBeNull()
      })

      const blobsActions = container.querySelector('[data-storage-actions="blobs"]')!
      const button = blobsActions.querySelector('button')!
      fireEvent.click(button)

      // Wait for optimizeAll to settle — its finally block has now called
      // scheduleStatusClear(), arming a pending STATUS_CLEAR_MS setTimeout.
      await waitFor(() => {
        expect(blobsActions.textContent ?? '').toMatch(/optimal|saved/i)
      })

      // Unmount while that setTimeout is still pending. This mirrors the
      // refresh()-focused unmount test above but exercises
      // scheduleStatusClear's own mountedRef branch instead of refresh()'s.
      unmount()

      // Tear down `window` before the timer fires — the same hazard the
      // refresh() test guards against, reached through scheduleStatusClear.
      await withWindowTornDown(
        () => new Promise((resolve) => setTimeout(resolve, STATUS_CLEAR_MS + 200)),
      )
    },
    STATUS_CLEAR_MS + 5000,
  )

  it(
    'clears the pending status-clear timer on unmount instead of leaking it',
    async () => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
      fetchMock.mockImplementation((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url === '/api/runtime/storage') {
          return Promise.resolve(jsonResponse(PAYLOAD))
        }
        if (url === '/api/workspaces') {
          return Promise.resolve(jsonResponse({ workspaces: [] }))
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`))
      })

      // Real timers — same reasoning as the sibling unmount test above.
      vi.useRealTimers()

      const { container, unmount } = render(<StorageReportCard />)
      await waitFor(() => {
        expect(container.querySelector('[data-storage-row="blobs"]')).not.toBeNull()
      })

      const blobsActions = container.querySelector('[data-storage-actions="blobs"]')!
      const button = blobsActions.querySelector('button')!
      fireEvent.click(button)

      // Wait for optimizeAll to settle — its finally block now holds a
      // pending STATUS_CLEAR_MS setTimeout id in pendingTimeoutIdsRef.
      await waitFor(() => {
        expect(blobsActions.textContent ?? '').toMatch(/optimal|saved/i)
      })

      const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
      unmount()
      // Unmount must actively cancel the still-pending status-clear timer
      // rather than leaving it scheduled with a now-orphaned callback.
      expect(clearTimeoutSpy).toHaveBeenCalled()
      clearTimeoutSpy.mockRestore()
    },
    STATUS_CLEAR_MS + 5000,
  )

  it('humanises the "Updated …" line and ticks across humanise boundaries without per-second flicker', async () => {
    const { container } = render(<StorageReportCard />)
    // Settle the initial fetch + min-refresh delay. The fresh fetch lands
    // <30s ago so the displayed string collapses to "just now".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(container.textContent ?? '').toMatch(/Updated just now/i)
    // Cross the minute boundary — the tick interval is 30s so the
    // humanise should advance to "1 minute ago" once the clock passes 60s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000)
    })
    expect(container.textContent ?? '').toMatch(/Updated\s+1\s+minute\s+ago/i)
  })
})
