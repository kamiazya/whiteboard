import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserWorkspaceScreen } from './app-screens.js'
import { errorBoundaryLog } from './components/ErrorBoundary.js'
import { expectLoggedFailure } from './test-utils/logged-failures.js'

// Its own file: the editor page must never enter the ESM cache here, so the
// frame's lazy() import genuinely REJECTS.
vi.mock('./pages/BrowserDocumentPage.js', () => {
  throw new Error('chunk load failed')
})
vi.mock('./pages/BrowserIndexPage.js', () => ({
  BrowserIndexPage: () => <p>document list</p>,
}))
vi.mock('./components/AppShell.js', () => ({
  AppShell: () => <header>browser shell</header>,
}))

afterEach(cleanup)

/** The route drives the screen the way App does: a document path opens the editor. */
function RoutedScreen() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const path = pathname.startsWith('/d/') ? pathname.slice('/d/'.length) : undefined
  return (
    <>
      <button type="button" onClick={() => navigate('/')}>
        to list
      </button>
      <BrowserWorkspaceScreen
        replica={null}
        onReconnect={() => {}}
        onOpenDocument={() => {}}
        revision={0}
        {...(path === undefined ? {} : { path })}
      />
    </>
  )
}

it('a rejected editor chunk keeps the shell, and leaving for the list clears the error screen', async () => {
  const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
  render(
    <MemoryRouter initialEntries={['/d/plan.md']}>
      <RoutedScreen />
    </MemoryRouter>,
  )
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(await screen.findByText('browser shell')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'to list' }))
  expect(await screen.findByText('document list')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(reportSpy).toHaveBeenCalled()
  reportSpy.mockRestore()
  await expectLoggedFailure('error when mocking a module')
})
