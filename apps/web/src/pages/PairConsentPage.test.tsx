import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PairConsentPage } from './PairConsentPage.js'

const HOSTED = 'https://latest.kamiazya-whiteboard.pages.dev'

afterEach(cleanup)

function renderPage({
  search = `?origin=${encodeURIComponent(HOSTED)}&challenge=chal&state=st-1`,
  fetchFn = vi.fn(),
  navigate = vi.fn(),
  daemonToken = 'daemon-secret' as string | undefined,
} = {}) {
  render(
    <MemoryRouter initialEntries={[`/pair${search}`]}>
      <PairConsentPage daemonToken={daemonToken} fetchFn={fetchFn} onNavigate={navigate} />
    </MemoryRouter>,
  )
  return { fetchFn, navigate }
}

describe('PairConsentPage', () => {
  it('renders the requesting origin and requires an explicit click on every path', () => {
    renderPage()
    expect(screen.getByText(HOSTED)).not.toBeNull()
    expect(screen.getByRole('button', { name: /approve/i })).not.toBeNull()
    expect(screen.getByRole('button', { name: /deny/i })).not.toBeNull()
  })

  it('Approve persists the grant and redirects back with the code fragment', async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ grantId: 'g1', origin: HOSTED, code: 'the-code' }, { status: 201 }),
    )
    const navigate = vi.fn()
    renderPage({ fetchFn: fetchFn as never, navigate })

    fireEvent.click(screen.getByRole('button', { name: /approve/i }))

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    expect(navigate.mock.calls[0]?.[0]).toBe(`${HOSTED}/#wb-grant=the-code&state=st-1`)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/pairing/grants')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer daemon-secret')
    expect(JSON.parse(String(init.body))).toEqual({ origin: HOSTED, codeChallenge: 'chal' })
  })

  it('Deny never calls the API and shows a denied notice', async () => {
    const fetchFn = vi.fn()
    const navigate = vi.fn()
    renderPage({ fetchFn: fetchFn as never, navigate })

    fireEvent.click(screen.getByRole('button', { name: /deny/i }))

    await screen.findByText(/denied/i)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('rejects a non-http(s) origin outright — no approve affordance', () => {
    renderPage({
      search: `?origin=${encodeURIComponent('javascript:alert(1)')}&challenge=c&state=s`,
    })
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
    expect(screen.getByText(/invalid pairing request/i)).not.toBeNull()
  })

  it('rejects missing parameters', () => {
    renderPage({ search: `?origin=${encodeURIComponent(HOSTED)}` })
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
  })

  it('surfaces a failed grant call instead of redirecting', async () => {
    const fetchFn = vi.fn(async () => new Response('nope', { status: 401 }))
    const navigate = vi.fn()
    renderPage({ fetchFn: fetchFn as never, navigate })

    fireEvent.click(screen.getByRole('button', { name: /approve/i }))

    await screen.findByText(/failed/i)
    expect(navigate).not.toHaveBeenCalled()
  })
})
