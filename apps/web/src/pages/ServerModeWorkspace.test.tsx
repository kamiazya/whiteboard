/**
 * A workspace a server-mode keeper serves is edited through the same daemon
 * document page as one reached through the extension, so what the keeper says
 * about a write — refused, or not landed yet — has to reach the person here
 * too. The page is stubbed: the notices read stores, not the page.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { resetShellStatusForTests, setShellConnection } from '../lib/shell-status-store.js'
import { dismissWriteRefusal, showWriteRefusal } from '../lib/write-refusal-store.js'
import { ServerModeWorkspace } from './ServerModeWorkspace.js'

vi.mock('./DaemonDocumentPage.js', () => ({
  DaemonDocumentPage: () => <p>document page</p>,
}))

afterEach(() => {
  cleanup()
  dismissWriteRefusal()
  resetShellStatusForTests()
})

async function openDocument() {
  render(
    <MemoryRouter initialEntries={['/w/team/d/notes/plan.md']}>
      <ServerModeWorkspace shell={<header>shell</header>} />
    </MemoryRouter>,
  )
  await screen.findByText('document page')
}

it('says why a change the keeper refused was undone', async () => {
  await openDocument()
  act(() => showWriteRefusal({ code: 'node_text_too_large', message: 'node of 300000' }))
  expect(screen.getByRole('alert').textContent).toContain('Your last change was not saved.')
})

it('asks before the tab closes while changes have not reached the keeper', async () => {
  await openDocument()
  act(() => setShellConnection({ state: { keeper: 'daemon', session: 'write-failed' } }))
  expect(screen.getByText(/Changes not saved yet/)).toBeTruthy()
  const leaving = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(leaving)
  expect(leaving.defaultPrevented).toBe(true)
})
