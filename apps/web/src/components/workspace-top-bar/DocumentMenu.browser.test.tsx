import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../../index.css'
import { DocumentMenu } from './DocumentMenu'

// Real Chromium rendering (not jsdom) of the Radix menu — the layer where the
// ARIA tree axe/AccessLint inspects actually exists, and where
// DismissableLayer's inerting of the surrounding page really happens.
function renderMenuWithSibling() {
  return render(
    <div>
      <button type="button">Back to documents</button>
      <DocumentMenu documentUrl="https://example.test/local/untitled" />
    </div>,
  )
}

afterEach(() => {
  cleanup()
})

describe('DocumentMenu (real Radix)', () => {
  it('announces a failed copy without nesting the alert inside the role="menu" element', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard permission denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    renderMenuWithSibling()

    await page.getByRole('button', { name: 'More actions' }).click()
    await page.getByText('Copy link').click()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("Couldn't copy automatically")

    const menu = screen.getByRole('menu')
    expect(menu.contains(alert)).toBe(false)

    // The announcement stays reachable in the accessibility tree even though
    // it is no longer a DOM child of the menu.
    const status = screen.getByRole('status', { name: 'Copy status' })
    expect(status.textContent).toContain("Couldn't copy the document link automatically.")
    expect(menu.contains(status)).toBe(false)

    // @ts-expect-error -- test-only cleanup of a property defined above
    delete navigator.clipboard
  })

  it('leaves no sibling control aria-hidden once the menu closes', async () => {
    renderMenuWithSibling()

    const sibling = screen.getByRole('button', { name: 'Back to documents' })
    expect(sibling.getAttribute('aria-hidden')).toBeNull()

    await page.getByRole('button', { name: 'More actions' }).click()
    await screen.findByRole('menu')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    // DismissableLayer inerts (aria-hides) the rest of the page while the menu
    // is open; closing it must fully restore every sibling rather than leaving
    // some of them permanently aria-hidden.
    expect(sibling.getAttribute('aria-hidden')).toBeNull()
  })
})
