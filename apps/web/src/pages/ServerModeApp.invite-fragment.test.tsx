/**
 * An invitation's token rides the link's fragment, which no server sees —
 * but the address bar, the session history and anything that reads
 * `location` afterwards do. Once the page has read the token it drops the
 * fragment, so Back, a shared screen or a copied URL does not carry it on.
 */
import {
  authAcceptInvitationUrl,
  invitePageUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerModeApp } from './ServerModeApp.js'

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

function keeperFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/auth/providers') {
      return Response.json({ providers: [{ id: 'corp', displayName: 'Corp SSO' }] })
    }
    if (url === '/auth/session') return Response.json({ signedIn: false })
    if (url === authAcceptInvitationUrl('corp') && init?.method === 'POST') {
      return Response.json({ location: 'https://idp.test/authorize' })
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  })
}

describe('server mode invite page', () => {
  it('drops the token from the address and history once read, and still accepts with it', async () => {
    const invite = new URL(invitePageUrl('https://keeper.test', 'inv-123'))
    window.history.pushState(null, '', `${invite.pathname}${invite.hash}`)
    const entries = window.history.length
    const fetchFn = keeperFetch()
    const goTo = vi.fn()

    render(
      <BrowserRouter>
        <ServerModeApp fetchFn={fetchFn} goTo={goTo} />
      </BrowserRouter>,
    )

    expect(await screen.findByRole('heading', { name: /invited/i })).toBeTruthy()
    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(window.location.href).not.toContain('inv-123')
    expect(window.location.pathname).toBe(invite.pathname)
    // Replaced, not pushed: Back must not land on the tokened entry.
    expect(window.history.length).toBe(entries)

    fireEvent.click(await screen.findByRole('button', { name: /continue with corp sso/i }))
    await waitFor(() => expect(goTo).toHaveBeenCalledWith('https://idp.test/authorize'))
    const posted = fetchFn.mock.calls.find(
      ([url]) => String(url) === authAcceptInvitationUrl('corp'),
    )
    expect(JSON.parse(String(posted?.[1]?.body))).toMatchObject({ invitation: 'inv-123' })
  })
})
