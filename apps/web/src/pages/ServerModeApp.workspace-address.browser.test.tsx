/**
 * ADR-0053's web grammar on server mode, through the real index page: the
 * address a person reads is `/w/<handle>/<segment>`, a link handed to
 * somebody else is the opaque `/w/<workspaceId>`, and an old one-component
 * segment address names nothing.
 */
import { authSessionUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { resetShellStatusForTests } from '../lib/shell-status-store.js'
import { installFakeDaemonFetch } from '../test-utils/fake-daemon-fetch.js'
import { ServerModeApp } from './ServerModeApp.js'

const ADA_PLANS = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const BOB_PLANS = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const ABSENT = '01CZZZZZZZZZZZZZZZZZZZZZZZ'

// Two namespaces holding the same segment: only the namespace tells them apart.
const workspaces = [
  { workspaceId: ADA_PLANS, namespace: 'ada', segment: 'plans', displayName: 'Ada plans' },
  { workspaceId: BOB_PLANS, namespace: 'bob', segment: 'plans', displayName: 'Bob plans' },
]

afterEach(() => {
  cleanup()
  resetShellStatusForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

let navigateTo: ReturnType<typeof useNavigate> | null = null
function AddressBar() {
  navigateTo = useNavigate()
  return <output data-testid="address">{useLocation().pathname}</output>
}

function openAt(entries: string[]) {
  const daemon = installFakeDaemonFetch({
    workspaces,
    documentsByWorkspace: {
      [ADA_PLANS]: [{ path: 'ada-roadmap' }],
      [BOB_PLANS]: [{ path: 'bob-roadmap' }],
    },
  })
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input), location.origin).pathname === authSessionUrl()
      ? Promise.resolve(
          Response.json({
            signedIn: true,
            user: { userId: 'u-1', displayName: 'Ada', administrator: false },
          }),
        )
      : daemon(input, init)
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <ServerModeApp fetchFn={fetchFn} />
      <AddressBar />
    </MemoryRouter>,
  )
  return daemon
}

const address = () => screen.getByTestId('address').textContent

/** Every workspace a request named, read off the documents route. */
function workspacesAsked(daemon: ReturnType<typeof installFakeDaemonFetch>): string[] {
  return daemon.mock.calls.flatMap(([input]) => {
    const match = String(input).match(/\/api\/workspaces\/([^/]+)\/documents/)
    return match === null ? [] : [decodeURIComponent(match[1] as string)]
  })
}

it('opens a qualified address in the namespace it names', async () => {
  const daemon = openAt(['/w/bob/plans'])
  expect(await screen.findByText('bob-roadmap')).toBeTruthy()
  expect(address()).toBe('/w/bob/plans')
  // Requests name the id: no route takes the qualified form.
  expect(workspacesAsked(daemon)).toContain(BOB_PLANS)
  expect(screen.queryByText('ada-roadmap')).toBeNull()
})

it('moves a member from the opaque link onto the readable address, replacing it', async () => {
  openAt(['/', `/w/${ADA_PLANS}`])
  expect(await screen.findByText('ada-roadmap')).toBeTruthy()
  await waitFor(() => expect(address()).toBe('/w/ada/plans'))
  // Replaced, not pushed: back leaves the workspace rather than returning
  // to an address that rewrites itself.
  navigateTo?.(-1)
  await waitFor(() => expect(address()).toBe('/'))
})

// Decision 2: an old `/w/<segment>` link is not redirected into anybody's
// namespace; it is answered as an id that names nothing is.
it('answers an old segment address exactly as an id naming nothing', async () => {
  const stale = openAt([`/w/${ABSENT}`])
  await screen.findByText('ada-roadmap')
  await waitFor(() => expect(address()).toBe('/w/ada/plans'))
  const absentAnswer = address()
  cleanup()

  const old = openAt(['/w/plans'])
  await screen.findByText('ada-roadmap')
  await waitFor(() => expect(address()).toBe(absentAnswer))
  expect(workspacesAsked(old)).not.toContain('plans')
  expect(workspacesAsked(stale)).not.toContain(ABSENT)
})

it('copies the opaque link, never the address bar', async () => {
  const written = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  openAt(['/w/ada/plans'])
  // Offered once the shell's list has said which workspace this is.
  fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }))
  expect(await screen.findByRole('button', { name: 'Link copied' })).toBeTruthy()
  expect(written).toHaveBeenCalledWith(`${location.origin}/w/${ADA_PLANS}`)
})
