/**
 * The touch formatting bar is mounted by boot beside the app, outside every
 * screen frame, so its failure is contained where boot mounts it: a rejected
 * panel chunk costs the bar and leaves the editor beside it mounted.
 */
import { screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { startBootSequence } from './boot.js'
import { errorBoundaryLog } from './components/ErrorBoundary.js'
import { expectLoggedFailure } from './test-utils/logged-failures.js'

vi.mock('./lib/file-sweep-schedule.js', () => ({ scheduleFileSweep: vi.fn() }))
// The server-mode entrance stands in for any app: the bar's sibling.
vi.mock('./pages/ServerModeApp.js', () => ({
  ServerModeApp: () => <main>editor with unsaved text</main>,
}))
// Its own file, so the panel never enters the ESM cache and the bar's lazy()
// import genuinely REJECTS.
vi.mock('./components/markdown-editor/TouchFormattingBarPanel.js', () => {
  throw new Error('chunk load failed')
})
// The gate open, as on a phone with a markdown editor holding the caret.
vi.mock('./components/markdown-editor/verb-bar-layout.js', () => ({
  touchFormattingBarShown: () => true,
}))

type ConfiguredWindow = { __WHITEBOARD_RUNTIME_CONFIG__?: unknown }

afterEach(() => {
  delete (window as ConfiguredWindow).__WHITEBOARD_RUNTIME_CONFIG__
  document.body.replaceChildren()
})

it('a rejected touch-bar panel chunk costs only the bar, never the editor beside it', async () => {
  const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
  ;(window as ConfiguredWindow).__WHITEBOARD_RUNTIME_CONFIG__ = { keeper: 'server' }
  const rootEl = document.createElement('div')
  document.body.appendChild(rootEl)
  await startBootSequence({
    rootEl,
    resolveWorkspaceId: async () => 'ws',
    loadFont: async () => undefined,
    dismissSplash: async () => undefined,
  })
  await screen.findByText('editor with unsaved text')
  await vi.waitFor(() => expect(reportSpy).toHaveBeenCalled())
  expect(screen.getByText('editor with unsaved text')).toBeTruthy()
  // Nothing in the bar's place: an error screen over the editor would cost
  // what the bar's own failure must not.
  expect(screen.queryByRole('alert')).toBeNull()
  reportSpy.mockRestore()
  await expectLoggedFailure('error when mocking a module')
})
