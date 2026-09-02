import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityTeaser } from './CapabilityTeaser.js'

afterEach(cleanup)

describe('CapabilityTeaser', () => {
  it('renders an aria-disabled, focusable control with an accessible description', () => {
    render(<CapabilityTeaser label="Version history" />)
    const control = screen.getByRole('button', { name: 'Version history' })
    expect(control.getAttribute('aria-disabled')).toBe('true')
    expect(control.tabIndex).toBe(0)
    const describedById = control.getAttribute('aria-describedby')
    expect(describedById).toBeTruthy()
    const description = document.getElementById(describedById as string)
    expect(description?.textContent).toBe('Connect a daemon (MCP) to enable Version history')
  })

  it('does not use native disabled (which would block focus and hide the tooltip)', () => {
    render(<CapabilityTeaser label="Workspaces" />)
    const control = screen.getByRole('button', { name: 'Workspaces' })
    expect(control.hasAttribute('disabled')).toBe(false)
  })

  it('is a no-op when clicked', () => {
    render(<CapabilityTeaser label="Branches" />)
    const control = screen.getByRole('button', { name: 'Branches' })
    control.click()
    // No throw, no navigation side effect — the control simply does nothing.
    expect(control.getAttribute('aria-disabled')).toBe('true')
  })

  it('does not bubble its click to a clickable ancestor', () => {
    // aria-disabled still dispatches/bubbles click; the control must stop it so
    // it stays inert even inside a clickable container.
    const onAncestorClick = vi.fn()
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test-only stand-in for a clickable ancestor container
      // biome-ignore lint/a11y/useKeyWithClickEvents: test-only stand-in for a clickable ancestor container
      <div onClick={onAncestorClick}>
        <CapabilityTeaser label="Merge" />
      </div>,
    )
    screen.getByRole('button', { name: 'Merge' }).click()
    expect(onAncestorClick).not.toHaveBeenCalled()
  })
})
