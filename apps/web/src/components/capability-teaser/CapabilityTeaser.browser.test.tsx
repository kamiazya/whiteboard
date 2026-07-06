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
          name: 'Connect a local daemon (MCP) to enable Version history',
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
      .element(
        page.getByRole('tooltip', { name: 'Connect a local daemon (MCP) to enable Workspaces' }),
      )
      .toBeVisible()
  })

  it('does not render a Radix tooltip trigger once the capability is enabled', async () => {
    render(<CapabilityTeaser label="Merge" enabled={true} />)
    const control = screen.getByRole('button', { name: 'Merge' })

    await userEvent.hover(control)
    expect(screen.queryByText('Connect a local daemon (MCP) to enable Merge')).toBeNull()
  })
})
