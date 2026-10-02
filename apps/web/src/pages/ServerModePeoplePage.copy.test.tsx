/**
 * The invitation link is shown once and is the secret, so the page's only
 * promise about it is that it reached the clipboard. "Copied" on a clipboard
 * that refused sends someone away holding nothing.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TenantPeoplePage } from './ServerModePeoplePage.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const LINK = { url: 'https://wb.test/invite#token=t-1', expiresAt: '2026-10-03T00:00:00.000Z' }

const keeper = async (input: RequestInfo | URL): Promise<Response> =>
  String(input) === '/api/invitations'
    ? Response.json(LINK, { status: 201 })
    : Response.json({ people: [] })

async function showLink(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  render(
    <MemoryRouter>
      <TenantPeoplePage fetchFn={keeper} selfId="u-me" />
    </MemoryRouter>,
  )
  fireEvent.click(await screen.findByRole('button', { name: /create invitation link/i }))
  await screen.findByDisplayValue(LINK.url)
}

describe('the invitation link Copy button', () => {
  it('says Copied once the clipboard took the link', async () => {
    const writeText = vi.fn(async () => undefined)
    await showLink(writeText)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledWith(LINK.url)
  })

  it('does not say Copied when the clipboard refuses', async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError')
    })
    await showLink(writeText)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled())
    // Let the rejection settle before asserting what did NOT happen.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
  })

  it('does not say Copied when there is no clipboard at all', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    render(
      <MemoryRouter>
        <TenantPeoplePage fetchFn={keeper} selfId="u-me" />
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /create invitation link/i }))
    await screen.findByDisplayValue(LINK.url)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
  })
})
