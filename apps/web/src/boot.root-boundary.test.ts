/**
 * The root boot renders has an error boundary of its own, outside every
 * Suspense: a frame's boundary covers the screens it wraps, and this one is
 * the floor for anything mounted outside a frame — the server-mode entrance,
 * the touch formatting bar — so a failure there shows a recoverable screen
 * rather than unmounting the root to a blank window.
 */
import { screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { startBootSequence } from './boot.js'
import { errorBoundaryLog } from './components/ErrorBoundary.js'
import { expectLoggedFailure } from './test-utils/logged-failures.js'

vi.mock('./lib/file-sweep-schedule.js', () => ({ scheduleFileSweep: vi.fn() }))
// Its own file, so the entrance never enters the ESM cache and boot's lazy()
// import genuinely REJECTS.
vi.mock('./pages/ServerModeApp.js', () => {
  throw new Error('chunk load failed')
})

type ConfiguredWindow = { __WHITEBOARD_RUNTIME_CONFIG__?: unknown }

afterEach(() => {
  delete (window as ConfiguredWindow).__WHITEBOARD_RUNTIME_CONFIG__
  document.body.replaceChildren()
})

it('a rejected server-mode entrance chunk lands in the root error boundary, not a blank root', async () => {
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
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(reportSpy).toHaveBeenCalled()
  reportSpy.mockRestore()
  await expectLoggedFailure('error when mocking a module')
})
