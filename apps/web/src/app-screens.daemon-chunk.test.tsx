import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { DaemonWorkspaceScreen } from './app-screens.js'
import { errorBoundaryLog } from './components/ErrorBoundary.js'
import type { WorkspaceRoute } from './lib/app-routes.js'
import { expectLoggedFailure } from './test-utils/logged-failures.js'

// Its own file: the gallery page must never enter the ESM cache here, so the
// screen's lazy() import genuinely REJECTS — what a tab left open across an
// upgrade gets when the chunk it asks for is no longer served.
vi.mock('./pages/DaemonIndexPage.js', () => {
  throw new Error('chunk load failed')
})
vi.mock('./pages/DaemonDocumentPage.js', () => ({
  DaemonDocumentPage: () => <p>document page</p>,
}))
vi.mock('./components/AppShell.js', () => ({
  AppShell: () => <header>daemon shell</header>,
}))

afterEach(cleanup)

const screenAt = (view: WorkspaceRoute) => (
  <MemoryRouter initialEntries={['/w/ws1']}>
    <DaemonWorkspaceScreen
      daemonBaseUrl="http://daemon.test"
      view={view}
      onView={() => {}}
      onWorkInBrowser={() => {}}
    />
  </MemoryRouter>
)

it('a rejected gallery chunk keeps the shell and leaves its error screen when a document opens', async () => {
  const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
  // App re-renders this same element for every workspace view, so the
  // boundary instance — and any error it holds — survives the navigation.
  const { rerender } = render(screenAt({ kind: 'index', workspace: 'ws1' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(await screen.findByText('daemon shell')).toBeTruthy()

  rerender(screenAt({ kind: 'document', workspace: 'ws1', path: 'notes/plan.md' }))
  expect(await screen.findByText('document page')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(reportSpy).toHaveBeenCalled()
  reportSpy.mockRestore()
  await expectLoggedFailure('error when mocking a module')
})
