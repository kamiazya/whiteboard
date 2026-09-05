import { storageCategorySchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { drainSchedulerMacrotasks } from '../test-utils/scheduler-drain.js'
import { STATUS_CLEAR_MS, StorageReportCard } from './StorageReportCard.js'

const PAYLOAD = {
  totalBytes: 4096,
  fileCount: 6,
  // Every category the contract declares. It used to omit `exports` and
  // `logs` and carry a `libraries` the daemon cannot report — a fixture
  // describing a payload no server sends, which is how the component's rows
  // were asserted against a shape nothing produced.
  byCategory: {
    blobs: { bytes: 1024, files: 2 },
    versions: { bytes: 2048, files: 1 },
    files: { bytes: 0, files: 0 },
    exports: { bytes: 0, files: 0 },
    logs: { bytes: 0, files: 0 },
    db: { bytes: 1024, files: 1 },
    other: { bytes: 0, files: 2 },
  },
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
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
  it('routes requests through the daemon fetch when a DaemonApiContext provider is mounted', async () => {
    const daemonFetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/runtime/storage')) return Promise.resolve(jsonResponse(PAYLOAD))
      if (url.endsWith('/api/runtime/logs/prune')) {
        return Promise.resolve(jsonResponse({ purgedCount: 1, purgedBytes: 512 }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    const { getByRole } = render(
      <DaemonApiContext.Provider value={daemonFetch}>
        <StorageReportCard />
      </DaemonApiContext.Provider>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(daemonFetch).toHaveBeenCalledWith('/api/runtime/storage')
    fireEvent.click(getByRole('button', { name: 'Prune old daemon logs' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(daemonFetch).toHaveBeenCalledWith('/api/runtime/logs/prune', { method: 'POST' })
  })

  it('renders exactly the categories the daemon can report, one row each', async () => {
    const { container } = render(<StorageReportCard />)
    // Compared against the contract's own union rather than a count. The
    // count was 8 and included `libraries`, a category the daemon lost the
    // ability to report when that feature's server half was deleted — the row
    // then showed a permanent 0 B, which reads as "nothing stored yet". A
    // number cannot tell those apart; the set can.
    //
    // This is the direction `key: StorageCategory` in the component does not
    // catch: that rejects a row for a category the contract does not have,
    // while this catches a category the contract gained and nobody rendered.
    const rendered = Array.from(container.querySelectorAll('[data-storage-row]')).map((row) =>
      row.getAttribute('data-storage-row'),
    )
    expect([...rendered].sort()).toEqual([...storageCategorySchema.options].sort())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const versionsRow = container.querySelector('[data-storage-row="versions"]')
    expect(versionsRow).not.toBeNull()
    expect(versionsRow!.textContent).toContain('Versions')
    expect(versionsRow!.textContent).toMatch(/2\.0\s*KiB|2048/)
    // Reserved per-row action slot is the OOUI hook for future Optimize.
    expect(container.querySelector('[data-storage-actions="versions"]')).not.toBeNull()
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
      if (init?.method === 'POST' && url.endsWith('/documents/optimize-all')) {
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
        .filter((c) => c.method === 'POST' && c.u.endsWith('/documents/optimize-all'))
        .map((c) => c.u)
        .sort()
      expect(optimizeUrls).toEqual([
        '/api/workspaces/ws_a/documents/optimize-all',
        '/api/workspaces/ws_b/documents/optimize-all',
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
    // Give React's own scheduler (MessageChannel/setImmediate based) a
    // chance to run any trailing post-unmount work now, while `window` is
    // still real — otherwise that work can fire later, after this test (or
    // this file) tears down its environment, and throw
    // "ReferenceError: window is not defined" attributed to an unrelated
    // test. Real timers only: fake timers do not advance setImmediate.
    vi.useRealTimers()
    await drainSchedulerMacrotasks()
    // Simulate the jsdom environment being torn down (as Vitest does once a
    // test file's tests finish) while refresh()'s pending setTimeout is
    // still scheduled. React 19 silently no-ops a setState call on an
    // already-unmounted root under a *live* jsdom window — the crash seen
    // in CI only reproduces once `window` itself is gone by the time the
    // timer fires, which is what actually happened: dispatchSetState
    // touched the (now-undefined) `window` and threw
    // "ReferenceError: window is not defined".
    const savedWindow = (globalThis as { window?: unknown }).window
    delete (globalThis as { window?: unknown }).window
    let thrown: unknown = null
    try {
      await new Promise((resolve) => setTimeout(resolve, 500))
    } catch (err) {
      thrown = err
    } finally {
      ;(globalThis as { window?: unknown }).window = savedWindow
    }
    expect(thrown).toBeNull()
    // Drain once more before returning so no scheduler callback armed
    // during the window-absent span above leaks into this file's Vitest
    // teardown either.
    await drainSchedulerMacrotasks()
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

      // Give React's own scheduler a bounded window to run any trailing
      // post-unmount work now, while `window` is still real — see
      // scheduler-drain.ts for why this is necessary even though the
      // component itself no longer leaks the status-clear timer past
      // unmount (that timer is clearTimeout-ed by the mount effect's
      // cleanup; this drains unrelated React-internal scheduler work).
      await drainSchedulerMacrotasks()

      // Simulate the jsdom environment being torn down before the timer
      // fires — the same "window is not defined" hazard the refresh() test
      // guards against, reached through a different handler this time.
      const savedWindow = (globalThis as { window?: unknown }).window
      delete (globalThis as { window?: unknown }).window
      let thrown: unknown = null
      try {
        await new Promise((resolve) => setTimeout(resolve, STATUS_CLEAR_MS + 200))
      } catch (err) {
        thrown = err
      } finally {
        ;(globalThis as { window?: unknown }).window = savedWindow
      }
      expect(thrown).toBeNull()
      // Drain once more before returning so no scheduler callback armed
      // during the window-absent span above leaks into this file's Vitest
      // teardown either.
      await drainSchedulerMacrotasks()
    },
    STATUS_CLEAR_MS + 5000,
  )

  it('clears the pending status-clear timer on unmount instead of leaking it', async () => {
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

    vi.useRealTimers()

    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')

    const { container, unmount } = render(<StorageReportCard />)
    await waitFor(() => {
      expect(container.querySelector('[data-storage-row="blobs"]')).not.toBeNull()
    })

    const blobsActions = container.querySelector('[data-storage-actions="blobs"]')!
    fireEvent.click(blobsActions.querySelector('button')!)

    // Wait for optimizeAll's finally block to arm the STATUS_CLEAR_MS timer
    // via scheduleStatusClear, then capture the exact id it returned — not
    // just "some" pending timer, since other setTimeout calls (e.g. the
    // min-refresh floor) share the component.
    let statusClearTimeoutId: ReturnType<typeof setTimeout> | undefined
    await waitFor(() => {
      const call = setTimeoutSpy.mock.calls.find(([, delay]) => delay === STATUS_CLEAR_MS)
      expect(call).toBeDefined()
      const index = setTimeoutSpy.mock.calls.indexOf(call!)
      statusClearTimeoutId = setTimeoutSpy.mock.results[index]?.value
      expect(statusClearTimeoutId).toBeDefined()
    })

    unmount()

    expect(clearTimeoutSpy).toHaveBeenCalledWith(statusClearTimeoutId)

    setTimeoutSpy.mockRestore()
    clearTimeoutSpy.mockRestore()
  })

  it('exposes Cleanup on the Versions row and aggregates sandwiched-auto-version prunes across workspaces', async () => {
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
      if (init?.method === 'POST' && url.endsWith('/versions/prune-sandwiched')) {
        return Promise.resolve(jsonResponse({ totalDeleted: url.includes('ws_a') ? 2 : 1 }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    vi.useRealTimers()
    const { container } = render(<StorageReportCard />)
    await waitFor(() => {
      expect(container.querySelector('[data-storage-row="versions"]')).not.toBeNull()
    })

    const versionsActions = container.querySelector('[data-storage-actions="versions"]')!
    fireEvent.click(versionsActions.querySelector('button')!)

    await waitFor(() => {
      expect(versionsActions.textContent ?? '').toMatch(/Removed\s+3\s+auto-version/i)
    })
  })

  it('exposes Cleanup on the Logs row and prunes old daemon logs', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/runtime/storage') {
        return Promise.resolve(jsonResponse(PAYLOAD))
      }
      if (init?.method === 'POST' && url === '/api/runtime/logs/prune') {
        return Promise.resolve(jsonResponse({ purgedCount: 5, purgedBytes: 10_240 }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    vi.useRealTimers()
    const { container } = render(<StorageReportCard />)
    await waitFor(() => {
      expect(container.querySelector('[data-storage-row="logs"]')).not.toBeNull()
    })

    const logsActions = container.querySelector('[data-storage-actions="logs"]')!
    fireEvent.click(logsActions.querySelector('button')!)

    await waitFor(() => {
      expect(logsActions.textContent ?? '').toMatch(/Removed\s+5/i)
    })
  })

  it('reports "Nothing to prune" when the Logs row Cleanup finds nothing to remove', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/runtime/storage') {
        return Promise.resolve(jsonResponse(PAYLOAD))
      }
      if (init?.method === 'POST' && url === '/api/runtime/logs/prune') {
        return Promise.resolve(jsonResponse({ purgedCount: 0, purgedBytes: 0 }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    vi.useRealTimers()
    const { container } = render(<StorageReportCard />)
    await waitFor(() => {
      expect(container.querySelector('[data-storage-row="logs"]')).not.toBeNull()
    })

    const logsActions = container.querySelector('[data-storage-actions="logs"]')!
    fireEvent.click(logsActions.querySelector('button')!)

    await waitFor(() => {
      expect(logsActions.textContent ?? '').toMatch(/Nothing to prune/i)
    })
  })

  it('shows "Optimize failed" when the workspaces list request itself fails', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/runtime/storage') {
        return Promise.resolve(jsonResponse(PAYLOAD))
      }
      if (url === '/api/workspaces') {
        return Promise.resolve(new Response(null, { status: 500 }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    vi.useRealTimers()
    const { container } = render(<StorageReportCard />)
    await waitFor(() => {
      expect(container.querySelector('[data-storage-row="blobs"]')).not.toBeNull()
    })

    const blobsActions = container.querySelector('[data-storage-actions="blobs"]')!
    fireEvent.click(blobsActions.querySelector('button')!)

    await waitFor(() => {
      expect(blobsActions.textContent ?? '').toMatch(/Optimize failed/i)
    })
  })

  it('shows "Cleanup failed" when the dangling-files workspaces list request itself fails', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/runtime/storage') {
        return Promise.resolve(jsonResponse(PAYLOAD))
      }
      if (url === '/api/workspaces') {
        return Promise.resolve(new Response(null, { status: 500 }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    vi.useRealTimers()
    const { container } = render(<StorageReportCard />)
    await waitFor(() => {
      expect(container.querySelector('[data-storage-row="files"]')).not.toBeNull()
    })

    const filesActions = container.querySelector('[data-storage-actions="files"]')!
    fireEvent.click(filesActions.querySelector('button')!)

    await waitFor(() => {
      expect(filesActions.textContent ?? '').toMatch(/Cleanup failed/i)
    })
  })

  it('surfaces a partial-failure note when Optimize all succeeds for some workspaces but not others', async () => {
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
      if (init?.method === 'POST' && url.endsWith('/documents/optimize-all')) {
        if (url.includes('ws_a')) {
          return Promise.resolve(new Response(null, { status: 500 }))
        }
        return Promise.resolve(jsonResponse({ totalBeforeBytes: 4000, totalAfterBytes: 1000 }))
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    vi.useRealTimers()
    const { container } = render(<StorageReportCard />)
    await waitFor(() => {
      expect(container.querySelector('[data-storage-row="blobs"]')).not.toBeNull()
    })

    const blobsActions = container.querySelector('[data-storage-actions="blobs"]')!
    fireEvent.click(blobsActions.querySelector('button')!)

    await waitFor(() => {
      expect(blobsActions.textContent ?? '').toMatch(/Saved.*1 workspace failed/i)
    })
  })

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
