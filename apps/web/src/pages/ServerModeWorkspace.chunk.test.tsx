import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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

afterEach(cleanup)

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
