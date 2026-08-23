import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { App } from './App.js'
import { BROWSER_CAPABILITIES, type ProviderState } from './lib/provider.js'

// Real browser: the not-found page arrives as a REAL lazy chunk (no ESM
// cache priming, no mocks), and clicking "Back to documents" navigates away
// from it. The destination page's own full mount is covered elsewhere —
// this pins the recovery affordance end-to-end in a real browser.
const BROWSER_STATE: ProviderState = {
  kind: 'browser',
  capabilities: BROWSER_CAPABILITIES,
}

describe('unknown-route recovery (real browser)', () => {
  it('loads the lazy not-found page and leaves it via Back to documents', async () => {
    render(
      <MemoryRouter initialEntries={['/definitely/not/a/route']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    const back = await screen.findByRole('button', { name: /back to documents/i })
    expect(document.querySelector('[data-mark="not-found"]')).toBeTruthy()

    back.click()

    await waitFor(() => {
      expect(document.querySelector('[data-mark="not-found"]')).toBeNull()
    })
  })
})
