import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { PairedOriginsCard } from './PairedOriginsCard.js'

afterEach(cleanup)

const GRANTS = [
  {
    grantId: 'g1',
    origin: 'https://latest.kamiazya-whiteboard.pages.dev',
    createdAt: '2026-08-07T00:00:00.000Z',
  },
  { grantId: 'g2', origin: 'https://example.com', createdAt: '2026-08-06T00:00:00.000Z' },
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
      <PairedOriginsCard />
    </DaemonApiContext.Provider>,
  )
  return fetchFn
}

describe('PairedOriginsCard', () => {
  it('lists every granted origin', async () => {
    renderCard(async () => jsonResponse({ grants: GRANTS }))

    await screen.findByText('https://latest.kamiazya-whiteboard.pages.dev')
    expect(screen.getByText('https://example.com')).not.toBeNull()
  })

  it('revokes a grant and removes its row', async () => {
    const fetchFn = renderCard(async (_url, init) => {
      if (init?.method === 'DELETE') return jsonResponse({ revoked: true })
      return jsonResponse({ grants: GRANTS })
    })

    await screen.findByText('https://example.com')
    fireEvent.click(screen.getByRole('button', { name: /revoke https:\/\/example\.com/i }))

    await waitFor(() => {
      expect(screen.queryByText('https://example.com')).toBeNull()
    })
    const deleteCall = fetchFn.mock.calls.find(([, init]) => init?.method === 'DELETE')
    expect(deleteCall?.[0]).toBe('/api/pairing/grants/g2')
    // The other grant stays.
    expect(screen.getByText('https://latest.kamiazya-whiteboard.pages.dev')).not.toBeNull()
  })

  it('shows an empty state when nothing is granted', async () => {
    renderCard(async () => jsonResponse({ grants: [] }))
    await screen.findByText(/no web apps are paired/i)
  })

  it('surfaces a failed revoke instead of dropping the row', async () => {
    renderCard(async (_url, init) => {
      if (init?.method === 'DELETE') return jsonResponse({ error: 'nope' }, 500)
      return jsonResponse({ grants: GRANTS })
    })

    await screen.findByText('https://example.com')
    fireEvent.click(screen.getByRole('button', { name: /revoke https:\/\/example\.com/i }))

    await screen.findByRole('alert')
    expect(screen.getByText('https://example.com')).not.toBeNull()
  })

  it('a stale response from a previous daemon never overwrites the active one', async () => {
    // Rerendering with a different DaemonApiContext fetch = a different
    // daemon. The OLD daemon's slow list resolving after the switch must
    // not clobber the new daemon's grants (its grantIds would then be sent
    // to the wrong daemon on revoke).
    let resolveOld: (r: Response) => void = () => {}
    const oldFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveOld = resolve
        }),
    )
    const newFetch = vi.fn(async () =>
      jsonResponse({
        grants: [
          {
            grantId: 'new-1',
            origin: 'https://new.example.com',
            createdAt: '2026-08-07T00:00:00.000Z',
          },
        ],
      }),
    )

    const { rerender } = render(
      <DaemonApiContext.Provider value={oldFetch as unknown as typeof globalThis.fetch}>
        <PairedOriginsCard />
      </DaemonApiContext.Provider>,
    )
    rerender(
      <DaemonApiContext.Provider value={newFetch as unknown as typeof globalThis.fetch}>
        <PairedOriginsCard />
      </DaemonApiContext.Provider>,
    )
    await screen.findByText('https://new.example.com')

    // The old daemon answers last — with different grants.
    resolveOld(jsonResponse({ grants: GRANTS }))
    await new Promise((r) => setTimeout(r, 50))

    expect(screen.getByText('https://new.example.com')).not.toBeNull()
    expect(screen.queryByText('https://example.com')).toBeNull()
  })

  it('renders a quiet error state when listing fails', async () => {
    renderCard(async () => jsonResponse({ error: 'boom' }, 500))
    await screen.findByText(/could not load paired web apps/i)
  })
})
