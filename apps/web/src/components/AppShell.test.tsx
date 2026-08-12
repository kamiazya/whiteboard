import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetInstallPromptForTests } from '@/lib/install-prompt-store'
import { resetShellStatusForTests, setShellDaemonAuthError } from '@/lib/shell-status-store'
import { resetSwStatusForTests } from '../pwa/sw-status-store.js'
import { AppShell } from './AppShell.js'

beforeEach(() => {
  localStorage.clear()
  resetSwStatusForTests()
  resetInstallPromptForTests()
  resetShellStatusForTests()
})

afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true })
})

function renderShell(daemonConnected: boolean, at = '/local/c1') {
  const router = createMemoryRouter(
    [{ path: '*', element: <AppShell daemon={daemonConnected} /> }],
    {
      initialEntries: [at],
    },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('AppShell', () => {
  it('brand mark links home', () => {
    renderShell(true)
    const home = screen.getByRole('link', { name: 'Home' })
    expect(home.getAttribute('href')).toBe('/')
  })

  it('alpha chip opens the honesty popover with a protect link', async () => {
    renderShell(true)
    fireEvent.click(screen.getByRole('button', { name: /alpha/i }))
    expect(await screen.findByText(/durability is not guaranteed/i)).toBeTruthy()
    const protect = screen.getByRole('link', { name: /protect your data/i })
    expect(protect.getAttribute('href')).toBe('/settings/data')
  })

  it('settings gear navigates to /settings carrying the entry point', () => {
    const router = renderShell(true, '/local/c1')
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(router.state.location.pathname).toBe('/settings')
    expect((router.state.location.state as { from?: string }).from).toBe('/local/c1')
  })

  it('names what the dot is about, so it reads as a task and not a warning', () => {
    renderShell(false)
    expect(screen.getByTestId('settings-nudge')).toBeTruthy()
    expect(screen.getByRole('button', { name: /settings.*(step|setup)/i })).toBeTruthy()
  })

  it('carries the nudge dot while a setup todo remains (no daemon)', () => {
    renderShell(false)
    expect(screen.getByTestId('settings-nudge')).toBeTruthy()
  })

  it('lights the nudge when the daemon page reports a live auth error', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.resolve(true) },
      configurable: true,
    })
    setShellDaemonAuthError(true)
    renderShell(true)
    expect(await screen.findByTestId('settings-nudge')).toBeTruthy()
  })

  it('shows no nudge when everything reachable is complete', async () => {
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.resolve(true) },
      configurable: true,
    })
    renderShell(true)
    // allow the persistence query to settle
    await screen.findByRole('button', { name: 'Settings' })
    expect(screen.queryByTestId('settings-nudge')).toBeNull()
  })
})
