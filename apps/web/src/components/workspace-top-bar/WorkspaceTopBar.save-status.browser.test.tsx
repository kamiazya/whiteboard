import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../index.css'
import { jsonResponse } from '../../test-utils/json-response.js'
import { setViewport } from '../../test-utils/viewport.js'
import WorkspaceTopBar from './WorkspaceTopBar'

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ workspace: 'W', documents: {}, pinned: [] })),
  )
})

afterEach(async () => {
  vi.unstubAllGlobals()
  cleanup()
  await setViewport(1280, 900)
})

const LONG_TITLE = 'A very long document title that wants every pixel of the row it can get'

function renderBar() {
  render(
    <WorkspaceTopBar
      workspaceId="sess_1"
      path="design/login-flow"
      onNavigateBack={() => {}}
      saveState={{
        persistence: { kind: 'saved', lastSavedAt: null },
        connection: { keeper: 'daemon', session: 'sync-off' },
      }}
      titleSlot={() => (
        <span data-testid="title" className="min-w-0 flex-1 truncate text-sm">
          {LONG_TITLE}
        </span>
      )}
    />,
  )
}

describe('the top bar save status', () => {
  it('shows an icon only on a phone and stays beside a truncated title', async () => {
    await setViewport(390, 800)
    renderBar()
    const status = screen.getByTestId('save-status')
    const header = screen.getByRole('banner')
    const box = status.getBoundingClientRect()
    expect(box.width).toBeLessThan(24)
    expect(box.right).toBeLessThanOrEqual(header.getBoundingClientRect().right)
    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth)
    expect(status.getAttribute('title')).toBe('Offline — changes kept here')
    expect(status.textContent).toContain('Offline — changes kept here')
  })

  it('spells the words out on a wide screen', async () => {
    await setViewport(1280, 800)
    renderBar()
    expect(screen.getByTestId('save-status').getBoundingClientRect().width).toBeGreaterThan(100)
  })
})
