// Real Radix Tooltip open/close for the icon-only "New canvas" control
// (ADR-0006 point 4 / accessibility criterion 2): jsdom cannot be trusted to
// portal-render Radix tooltip content, so this asserts on hover AND on
// keyboard focus in a real browser instead of only structurally in jsdom.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { DaemonIndexPage } from './DaemonIndexPage.js'

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubFetch(onCreateCanvas: (workspaceId: string, slug: string) => void) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      const canvasesMatch = url.match(/\/api\/workspaces\/([^/]+)\/canvases$/)
      if (canvasesMatch && init?.method === 'POST') {
        const workspaceId = decodeURIComponent(canvasesMatch[1])
        const body = JSON.parse(String(init.body)) as { slug: string }
        onCreateCanvas(workspaceId, body.slug)
        return Promise.resolve(jsonResponse({ slug: body.slug }))
      }
      if (canvasesMatch) {
        // Non-empty: the toolbar (search + the New canvas menu trigger) only
        // renders when the list has rows — an empty list shows the empty
        // state instead.
        return Promise.resolve(
          jsonResponse({ canvases: [{ slug: 'existing', updatedAt: '2026-01-01T00:00:00Z' }] }),
        )
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    }),
  )
}

describe('DaemonIndexPage New canvas control (browser — real Radix Tooltip)', () => {
  it('reveals the tooltip on real hover', async () => {
    stubFetch(() => {})
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)

    const button = await screen.findByRole('button', { name: 'New canvas' })
    await userEvent.hover(button)

    await expect.element(page.getByRole('tooltip', { name: 'New canvas' })).toBeVisible()

    await userEvent.unhover(button)
  })

  it('reveals the tooltip on real keyboard focus, and Enter opens the kind menu whose entry creates', async () => {
    const created: Array<[string, string]> = []
    stubFetch((workspaceId, slug) => created.push([workspaceId, slug]))
    const onOpenCanvas = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={onOpenCanvas} />)

    // Tab through the toolbar controls in DOM order until "New canvas" is
    // focused — asserting reachability by keyboard alone, not by a direct
    // ref/click shortcut.
    const button = await screen.findByRole('button', { name: 'New canvas' })
    for (let i = 0; i < 10 && document.activeElement !== button; i++) {
      await userEvent.tab()
    }
    expect(button).toHaveFocus()

    await expect.element(page.getByRole('tooltip', { name: 'New canvas' })).toBeVisible()

    // Enter opens the kind menu (focus lands on it), Enter again picks the
    // focused "New canvas" entry — the whole creation is keyboard-reachable.
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByRole('menuitem', { name: 'New canvas' })).toBeVisible()
    await userEvent.keyboard('{Enter}')
    await expect.poll(() => created).toEqual([['ws-a', 'untitled']])
    await expect.poll(() => onOpenCanvas.mock.calls).toEqual([['ws-a', 'untitled']])
  })
})
