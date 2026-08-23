import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { CapabilityTeaser } from './CapabilityTeaser.js'

afterEach(cleanup)

describe('CapabilityTeaser (browser — real Radix Tooltip open/close)', () => {
  it('opens the Radix tooltip with the guidance text on real hover', async () => {
    render(<CapabilityTeaser label="Version history" enabled={false} />)
    const control = screen.getByRole('button', { name: 'Version history' })

    await userEvent.hover(control)
    await expect
      .element(
        page.getByRole('tooltip', {
          name: 'Connect a daemon (MCP) to enable Version history',
        }),
      )
      .toBeVisible()

    await userEvent.unhover(control)
  })

  it('opens the Radix tooltip on real keyboard focus', async () => {
    render(
      <>
        <button type="button">before</button>
        <CapabilityTeaser label="Workspaces" enabled={false} />
      </>,
    )

    await userEvent.tab() // focuses "before"
    await userEvent.tab() // focuses the teaser control
    const control = screen.getByRole('button', { name: 'Workspaces' })
    expect(control).toHaveFocus()

    await expect
      .element(page.getByRole('tooltip', { name: 'Connect a daemon (MCP) to enable Workspaces' }))
      .toBeVisible()
  })

  it('keeps aria-describedby resolving to the guidance text while the tooltip is CLOSED', async () => {
    // Radix TooltipTrigger asChild composes its own aria-describedby onto the
    // child on open and may not merge a manually-set one. This asserts that in
    // the closed (default) state the button's aria-describedby still resolves to
    // an element carrying the guidance text — so screen-reader users get the
    // description without having to open the tooltip.
    render(<CapabilityTeaser label="Branches" enabled={false} />)
    const control = screen.getByRole('button', { name: 'Branches' })
    const describedBy = control.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const descEl = document.getElementById(describedBy!.split(' ')[0])
    expect(descEl?.textContent).toBe('Connect a daemon (MCP) to enable Branches')
  })

  it('does not render a Radix tooltip trigger once the capability is enabled', async () => {
    render(<CapabilityTeaser label="Merge" enabled={true} />)
    const control = screen.getByRole('button', { name: 'Merge' })

    await userEvent.hover(control)
    expect(screen.queryByText('Connect a daemon (MCP) to enable Merge')).toBeNull()
  })
})
