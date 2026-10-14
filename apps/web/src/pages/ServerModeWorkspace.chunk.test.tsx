import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { errorBoundaryLog } from '../components/ErrorBoundary.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { ServerModeWorkspace } from './ServerModeWorkspace.js'

// Its own file: the gallery page must never enter the ESM cache here, so the
// frame's lazy() import genuinely REJECTS — what a tab left open across a
// keeper upgrade gets when the chunk it asks for is no longer served.
vi.mock('./DaemonIndexPage.js', () => {
  throw new Error('chunk load failed')
})
vi.mock('./DaemonDocumentPage.js', () => ({
  DaemonDocumentPage: () => <p>document page</p>,
}))

afterEach(cleanup)

function OpenDocumentButton() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate('/w/ws1/d/plan.md')}>
      open document
    </button>
  )
}

it('a rejected page chunk lands in the error boundary and keeps the server-mode header', async () => {
  const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
  render(
    <MemoryRouter initialEntries={['/w/ws1']}>
      <ServerModeWorkspace shell={<header>server shell</header>} />
    </MemoryRouter>,
  )
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByText('server shell')).toBeTruthy()
  expect(reportSpy).toHaveBeenCalled()
  reportSpy.mockRestore()
  await expectLoggedFailure('error when mocking a module')
})

it('a rejected gallery chunk leaves its error screen when a document opens', async () => {
  const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
  render(
    <MemoryRouter initialEntries={['/w/ws1']}>
      <OpenDocumentButton />
      <ServerModeWorkspace shell={<header>server shell</header>} />
    </MemoryRouter>,
  )
  expect(await screen.findByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'open document' }))
  expect(await screen.findByText('document page')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  reportSpy.mockRestore()
  await expectLoggedFailure('error when mocking a module')
})
