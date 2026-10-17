/**
 * The daemon page keeps this device's memory of a workspace under the
 * workspace's canonical id and the daemon it came from — not under the
 * address handle, which a browser workspace shares (`default`) and a rename
 * moves.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { STORAGE_KEY } from '../lib/recent-documents.js'
import { installFakeDaemonFetch } from '../test-utils/fake-daemon-fetch.js'
import { DaemonIndexPage } from './DaemonIndexPage.js'

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'
const WS_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.removeItem(STORAGE_KEY)
})

it('records an open under the daemon and workspace id, not the segment', async () => {
  installFakeDaemonFetch({
    workspaces: [{ workspaceId: WS_ULID, segment: 'default' }],
    documentsByWorkspace: {
      [WS_ULID]: [{ path: 'alpha', updatedAt: new Date().toISOString() }],
    },
  })
  render(
    <MemoryRouter initialEntries={['/']}>
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />
    </MemoryRouter>,
  )

  const card = (await screen.findByTestId('card-title')).closest('button')
  if (card === null) throw new Error('no card')
  fireEvent.doubleClick(card)

  await waitFor(() =>
    expect(Object.keys(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))).toEqual([
      `daemon:${DAEMON_BASE_URL}:${WS_ULID}`,
    ]),
  )
})
