import { act, cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetInstallPromptForTests } from '../lib/install-prompt-store.js'
import { resetSwStatusForTests } from '../pwa/sw-status-store.js'
import { SettingsPage } from './SettingsPage.js'

beforeEach(() => {
  localStorage.clear()
  resetSwStatusForTests()
  resetInstallPromptForTests()
})

afterEach(cleanup)

function renderAt(path: string, daemon?: { baseUrl: string }) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsPage daemon={daemon} />
    </MemoryRouter>,
  )
}

describe('SettingsPage — setup attention on the section list', () => {
  const dataRow = () =>
    within(screen.getByTestId('settings-nav-mobile')).getByRole('link', {
      name: /Data & app/,
    })

  it('marks the Data & app row while a setup step is waiting, as the gear does', () => {
    renderAt('/settings')
    expect(within(dataRow()).getByTestId('settings-nav-nudge')).toBeTruthy()
    expect(dataRow().textContent).toContain('a setup step is waiting')
  })

  it('leaves the row plain once nothing is waiting', async () => {
    renderAt('/settings', { baseUrl: 'http://127.0.0.1:9999' })
    // The persistence query answers asynchronously; the dot must not flash on first.
    await act(async () => {})
    expect(within(dataRow()).queryByTestId('settings-nav-nudge')).toBeNull()
  })
})
