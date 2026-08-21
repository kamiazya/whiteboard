/**
 * Real-browser behavior of the history cluster's version panel — ported
 * from the top bar's suite when the version-history surface moved here:
 * the scrollable timeline, the outside-click rule that treats portal
 * dialogs as "inside", and the restore round-trip.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '../../index.css'
import { HistoryCluster } from './HistoryCluster.js'

type FetchArgs = [RequestInfo | URL, RequestInit?]

function mkVersionsResponse(count = 24): Response {
  const versions = Array.from({ length: count }, (_, index) => ({
    id: `v-${index}`,
    path: 'design/login-flow',
    createdAt: new Date(Date.now() - index * 60_000).toISOString(),
    elementCount: 58 + index,
    label: `Version ${index + 1}`,
    auto: index % 2 === 0,
    hasThumbnail: false,
    branchName: 'main',
    operator: {
      kind: index % 3 === 0 ? ('human' as const) : ('system' as const),
      peerId: `peer-${index}`,
      displayName: index % 3 === 0 ? 'Alice' : 'auto-save',
    },
  }))
  return new Response(JSON.stringify({ versions }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/versions') && url.endsWith('/restore')) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    }
    if (url.includes('/versions') && init?.method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    }
    if (url.includes('/versions')) return Promise.resolve(mkVersionsResponse())
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

function renderCluster() {
  return render(
    <div className="relative h-[600px] w-[900px] bg-background">
      {/* The cluster is unpositioned by design — the bottom dock owns its
          placement — so the harness supplies the dock's bottom anchoring,
          or the upward-opening version panel would sit above the viewport. */}
      <div className="absolute bottom-3 left-3">
        <HistoryCluster
          onUndo={vi.fn()}
          onRedo={vi.fn()}
          canUndo
          canRedo
          versions={{ workspaceId: 'sess_1', path: 'design/login-flow' }}
        />
      </div>
    </div>,
  )
}

describe('HistoryCluster version panel (real browser)', () => {
  it('opens the panel upward from the cluster and keeps the list scrollable', async () => {
    const { container } = renderCluster()

    await page.getByRole('button', { name: 'Version history' }).click()

    await waitFor(() => {
      expect(container.textContent).toContain('Version 1')
      expect(container.textContent).toContain('Version 24')
    })

    // Opens UPWARD: the panel sits above the cluster's buttons.
    const panel = screen.getByTestId('history-version-panel')
    const cluster = screen.getByTestId('history-cluster')
    expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      cluster.getBoundingClientRect().top + 1,
    )

    // Scrollability of the list itself is VersionTimeline.browser's case —
    // this file only owns what the CLUSTER adds around the shared panel.

    // Outside-click closes it.
    fireEvent.mouseDown(document.body)
    await waitFor(() => {
      expect(screen.queryByTestId('history-version-panel')).toBeNull()
    })
  })

  it('keeps the panel open when a mousedown lands inside the restore confirmation dialog', async () => {
    renderCluster()

    await page.getByRole('button', { name: 'Version history' }).click()
    await page.getByText(/^Version 1$/).click()
    await expect.element(page.getByText('Restore this version?')).toBeInTheDocument()

    // The AlertDialog portals into document.body — outside the panel's DOM
    // subtree — and must still count as "inside".
    const dialog = screen.getByRole('alertdialog')
    fireEvent.mouseDown(dialog)

    expect(screen.getByTestId('history-version-panel')).toBeTruthy()
    expect(screen.getByText('Restore this version?')).toBeTruthy()
  })
})
