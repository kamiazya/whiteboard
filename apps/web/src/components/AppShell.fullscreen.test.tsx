// @vitest-environment jsdom

/**
 * Fullscreen is the SHELL's: one control in the app row on every page,
 * targeting the whole document, and in fullscreen both chrome rows step
 * aside with one floating way back out. It used to be the browser document
 * page's own — a `<main>` target, a top-bar button plus a kebab copy, and
 * nothing at all on the daemon page.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetInstallPromptForTests } from '../lib/install-prompt-store.js'
import { resetShellStatusForTests } from '../lib/shell-status-store.js'
import { resetSwStatusForTests } from '../pwa/sw-status-store.js'
import { AppShell } from './AppShell.js'

beforeEach(() => {
  localStorage.clear()
  resetSwStatusForTests()
  resetInstallPromptForTests()
  resetShellStatusForTests()
  // jsdom has no fullscreen at all; start each test explicitly OUT of it,
  // and present a capable environment — the method has to exist before the
  // shell renders, since that is when it reads the capability.
  setFullscreenElement(null)
  Element.prototype.requestFullscreen = vi.fn(() => Promise.resolve())
})

afterEach(() => {
  cleanup()
  setFullscreenElement(null)
  delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen
  vi.restoreAllMocks()
})

/** jsdom has no real fullscreen; the shell only reads this and the event. */
function setFullscreenElement(el: Element | null) {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => el,
  })
  document.dispatchEvent(new Event('fullscreenchange'))
}

function renderShell(at = '/settings') {
  const router = createMemoryRouter([{ path: '*', element: <AppShell daemon={false} /> }], {
    initialEntries: [at],
  })
  render(<RouterProvider router={router} />)
}

it('offers Fullscreen in the shell row on a page with no document, and targets the whole document', () => {
  renderShell('/settings')
  const toggle = screen.getByRole('button', { name: 'Fullscreen' })
  toggle.click()
  expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(1)
})

it('steps the shell row aside in fullscreen, floats one exit control, and hands focus across', async () => {
  renderShell()
  const exitFullscreen = vi.fn(async () => {})
  document.exitFullscreen = exitFullscreen
  expect(screen.queryByRole('button', { name: 'Exit fullscreen' })).toBeNull()

  await act(async () => {
    setFullscreenElement(document.documentElement)
  })
  // The row is gone — settings gear included — and the one way back holds
  // focus, since the control that was just activated unmounted with it.
  expect(screen.queryByTestId('shell-settings')).toBeNull()
  const exit = screen.getByRole('button', { name: 'Exit fullscreen' })
  expect(document.activeElement).toBe(exit)
  exit.click()
  expect(exitFullscreen).toHaveBeenCalledTimes(1)

  await act(async () => {
    setFullscreenElement(null)
  })
  expect(screen.queryByRole('button', { name: 'Exit fullscreen' })).toBeNull()
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fullscreen' })),
  )
})

it('a rejected requestFullscreen is reported, not an unhandled rejection', async () => {
  renderShell()
  const rejection = new DOMException('denied', 'NotAllowedError')
  Element.prototype.requestFullscreen = vi.fn(() => Promise.reject(rejection))
  const warnings: unknown[] = []
  vi.spyOn(console, 'warn').mockImplementation((...args) => void warnings.push(args))

  screen.getByRole('button', { name: 'Fullscreen' }).click()
  await act(async () => {
    await Promise.resolve()
  })
  expect(warnings.some((args) => JSON.stringify(args).includes('requestFullscreen'))).toBe(true)
})
