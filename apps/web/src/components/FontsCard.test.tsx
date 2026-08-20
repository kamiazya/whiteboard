import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { FontsCard, formatSize } from './FontsCard.js'

afterEach(cleanup)

const FONTS = [
  {
    id: 'noto-sans-jp',
    family: 'Noto Sans JP',
    scripts: ['Japanese'],
    license: 'OFL-1.1' as const,
    approxBytes: 9_589_900,
    installed: false,
  },
  {
    id: 'noto-sans-kr',
    family: 'Noto Sans KR',
    scripts: ['Korean'],
    license: 'OFL-1.1' as const,
    approxBytes: 10_414_588,
    installed: true,
  },
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderCard(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchFn = vi.fn(fetchImpl)
  render(
    <DaemonApiContext.Provider value={fetchFn as unknown as typeof globalThis.fetch}>
      <FontsCard />
    </DaemonApiContext.Provider>,
  )
  return fetchFn
}

describe('formatSize', () => {
  // Whole megabytes suit the CJK faces this list exists for and print "0 MB"
  // for the small ones. A size shown before a download must not round away.
  it('never rounds a real file down to nothing', () => {
    expect(formatSize(112_640)).toBe('113 KB')
    expect(formatSize(218_652)).toBe('219 KB')
    expect(formatSize(9_589_900)).toBe('10 MB')
    expect(formatSize(17_772_300)).toBe('18 MB')
  })
})

describe('FontsCard', () => {
  it('lists the catalogue, and offers Install only for what the daemon lacks', async () => {
    renderCard(async () => jsonResponse({ fonts: FONTS }))

    await screen.findByText('Noto Sans JP')
    expect(screen.getByRole('button', { name: 'Install Noto Sans JP' })).not.toBeNull()
    // The already-installed one has nothing to press.
    expect(screen.queryByRole('button', { name: 'Install Noto Sans KR' })).toBeNull()
    expect(screen.getByText(/Japanese · 10 MB · OFL-1.1/)).not.toBeNull()
  })

  it('installs by id and marks the row without a refetch', async () => {
    const fetchFn = renderCard(async (url, init) => {
      if (init?.method === 'POST') {
        return jsonResponse({ id: 'noto-sans-jp', family: 'Noto Sans JP', bytes: 9_589_900 })
      }
      expect(url).toBe('/api/fonts')
      return jsonResponse({ fonts: FONTS })
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Install Noto Sans JP' }))

    // The id, in the path, and no URL anywhere near the request — the whole
    // reason the daemon accepts a catalogue id.
    await waitFor(() => {
      expect(fetchFn).toHaveBeenCalledWith('/api/fonts/noto-sans-jp/install', { method: 'POST' })
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Install Noto Sans JP' })).toBeNull()
    })
  })

  it('leaves the row installable and says why when the download fails', async () => {
    renderCard(async (_url, init) =>
      init?.method === 'POST'
        ? jsonResponse({ error: 'unreachable', message: 'Could not download Noto Sans JP.' }, 502)
        : jsonResponse({ fonts: FONTS }),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Install Noto Sans JP' }))

    // The daemon-authored reason, not a generic failure: "the source is down"
    // and "that font does not exist" are different problems for the user.
    await screen.findByText('Could not download Noto Sans JP.')
    expect(screen.getByRole('button', { name: 'Install Noto Sans JP' })).not.toBeNull()
  })

  it('reports a catalogue it could not load at all', async () => {
    renderCard(async () => jsonResponse({ error: 'nope', message: 'Daemon unavailable.' }, 500))

    await screen.findByText('Daemon unavailable.')
  })
})
