import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hoisted mock in a dedicated file: NotFoundPage must never enter the ESM
// cache here, so App's lazy() import genuinely REJECTS — the scenario a
// failed chunk fetch produces in production.
vi.mock('./pages/BrowserLocalDocumentPage.js', () => ({
  BrowserLocalDocumentPage: () => null,
}))
vi.mock('./components/status/NotFoundPage.js', () => {
  throw new Error('chunk load failed')
})

import { App } from './App.js'
import { errorBoundaryLog } from './components/ErrorBoundary.js'
import { BROWSER_CAPABILITIES, type ProviderState } from './lib/provider.js'

afterEach(cleanup)

const BROWSER_STATE: ProviderState = {
  kind: 'browser',
  capabilities: BROWSER_CAPABILITIES,
}

describe('App not-found chunk failure', () => {
  it('a rejected NotFoundPage chunk lands in the error boundary, not a blank root', async () => {
    const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
    render(
      <MemoryRouter initialEntries={['/definitely/not/a/route']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
    reportSpy.mockRestore()
  })
})
