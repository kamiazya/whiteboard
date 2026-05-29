// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Stub heavy/irrelevant dependencies so the component mounts without network or browser-only requirements.
vi.mock('./HeaderBranchChip.js', () => ({ HeaderBranchChip: () => null }))
vi.mock('./HeaderSaveDot.js', () => ({ HeaderSaveDot: () => null }))
vi.mock('./VersionTimeline.js', () => ({ default: () => null }))
vi.mock('../hooks/useDirtyState.js', () => ({ useDirtyState: () => ({ isDirty: false }) }))
vi.mock('../lib/api-client.js', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '../lib/api-client.js'
import WorkspaceTopBar from './WorkspaceTopBar.js'

function mkNamesOk() {
  return new Response(
    JSON.stringify({ workspace: 'My WS', canvases: {}, pinned: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function renderBar() {
  // React 18 delegates events to the root container. Radix portals render into document.body,
  // which is a DOM sibling of the default test container. Using document.body as the React root
  // ensures portal events bubble to React's listener.
  return render(
    <MemoryRouter>
      <WorkspaceTopBar
        workspaceId="ws_1"
        slug="canvas-a"
        canvases={[{ slug: 'canvas-a', updatedAt: '2026-04-23T00:00:00Z' }]}
        onEnterFullscreen={() => {}}
      />
    </MemoryRouter>,
    { container: document.body },
  )
}

// Open the new canvas dialog through the canvas switcher dropdown.
// Radix DropdownMenuTrigger opens on pointerDown (not click); DropdownMenuItem selects on pointerUp.
async function openNewCanvasDialog() {
  // The canvas switcher trigger is the button that shows the current canvas slug.
  const switcher = screen.getByRole('button', { name: /canvas-a/i })
  // pointerDown with button=0 triggers Radix's internal open handler.
  fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
  // After the dropdown opens, pointerUp on the item triggers onSelect → openNewCanvas().
  const item = await screen.findByTestId('new-canvas-menu-item')
  fireEvent.pointerUp(item)
  await screen.findByRole('dialog')
}

// Fill in the slug field and click Create.
async function submitSlug(slug: string) {
  const input = screen.getByPlaceholderText('e.g. design/login-flow')
  fireEvent.change(input, { target: { value: slug } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
}

beforeEach(() => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).includes('/names')) return mkNamesOk()
    return new Response('{}', { status: 200 })
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WorkspaceTopBar — new canvas error rendering (P-HTTP-005)', () => {
  it('shows Problem Details body.title when the server returns a 409 with title', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/names')) return mkNamesOk()
      // POST /canvases → 409 Problem Details
      return new Response(
        JSON.stringify({
          type: 'https://example.com/problems/canvas_conflict',
          title: 'Canvas already exists',
          status: 409,
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )
    })

    renderBar()
    await openNewCanvasDialog()
    await submitSlug('existing-canvas')

    await waitFor(() => {
      expect(screen.getByText('Canvas already exists')).toBeTruthy()
    })
  })

  it('shows fallback and never exposes body.message (P-HTTP-005)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/names')) return mkNamesOk()
      // Legacy response with sensitive body.message
      return new Response(
        JSON.stringify({ message: '/Users/alice/secret-path/config.json' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    })

    renderBar()
    await openNewCanvasDialog()
    await submitSlug('any-slug')

    await waitFor(() => {
      expect(screen.getByText('Failed to create canvas.')).toBeTruthy()
    })
    expect(screen.queryByText(/secret-path/i)).toBeNull()
    expect(screen.queryByText(/\/Users\//i)).toBeNull()
  })

  it('shows fallback and never exposes Error.message when fetch throws (P-HTTP-005)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/names')) return mkNamesOk()
      throw new Error('Authorization: Bearer secret-token-XYZ')
    })

    renderBar()
    await openNewCanvasDialog()
    await submitSlug('any-slug')

    await waitFor(() => {
      expect(screen.getByText('Failed to create canvas.')).toBeTruthy()
    })
    expect(screen.queryByText(/secret-token/i)).toBeNull()
    expect(screen.queryByText(/Authorization/i)).toBeNull()
  })

  it('closes the dialog and does not show an error on successful creation', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('/names')) return mkNamesOk()
      return new Response('{}', { status: 200 })
    })

    renderBar()
    await openNewCanvasDialog()
    await submitSlug('new-canvas')

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(screen.queryByText('Failed to create canvas.')).toBeNull()
  })

  it('shows the slug validation error inline without making a fetch request', async () => {
    renderBar()
    await openNewCanvasDialog()
    await submitSlug('bad/')

    await waitFor(() => {
      expect(screen.getByText(/enter a slug/i)).toBeTruthy()
    })
    // No POST request should have been made for invalid slugs.
    const calls = vi.mocked(apiFetch).mock.calls.filter(
      ([url, init]) => String(url).includes('/canvases') && (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(calls).toHaveLength(0)
  })
})
