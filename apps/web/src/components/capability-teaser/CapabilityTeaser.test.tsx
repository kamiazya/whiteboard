import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityTeaser } from './CapabilityTeaser.js'

afterEach(cleanup)

describe('CapabilityTeaser', () => {
  it('renders an aria-disabled, focusable control with an accessible description when disabled', () => {
    render(<CapabilityTeaser label="Version history" enabled={false} />)
    const control = screen.getByRole('button', { name: 'Version history' })
    expect(control.getAttribute('aria-disabled')).toBe('true')
    expect(control.tabIndex).toBe(0)
    const describedById = control.getAttribute('aria-describedby')
    expect(describedById).toBeTruthy()
    const description = document.getElementById(describedById as string)
    expect(description?.textContent).toBe('Connect a local daemon (MCP) to enable Version history')
  })

  it('does not use native disabled (which would block focus and hide the tooltip)', () => {
    render(<CapabilityTeaser label="Workspaces" enabled={false} />)
    const control = screen.getByRole('button', { name: 'Workspaces' })
    expect(control.hasAttribute('disabled')).toBe(false)
  })

  it('is a no-op when clicked while disabled', () => {
    render(<CapabilityTeaser label="Branches" enabled={false} />)
    const control = screen.getByRole('button', { name: 'Branches' })
    control.click()
    // No throw, no navigation side effect — the control simply does nothing.
    expect(control.getAttribute('aria-disabled')).toBe('true')
  })

  it('mutation-check: drops aria-disabled and the sr-only description once the capability is enabled', () => {
    render(<CapabilityTeaser label="Merge" enabled={true} />)
    const control = screen.getByRole('button', { name: 'Merge' })
    expect(control.getAttribute('aria-disabled')).toBeNull()
    expect(control.getAttribute('aria-describedby')).toBeNull()
    expect(screen.queryByText('Connect a local daemon (MCP) to enable Merge')).toBeNull()
  })
})
