import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(description?.textContent).toBe('Connect a daemon (MCP) to enable Version history')
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

  it('does not bubble its click to a clickable ancestor while disabled', () => {
    // aria-disabled still dispatches/bubbles click; the control must stop it so
    // it stays inert even inside a clickable container.
    const onAncestorClick = vi.fn()
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test-only stand-in for a clickable ancestor container
      // biome-ignore lint/a11y/useKeyWithClickEvents: test-only stand-in for a clickable ancestor container
      <div onClick={onAncestorClick}>
        <CapabilityTeaser label="Merge" enabled={false} />
      </div>,
    )
    screen.getByRole('button', { name: 'Merge' }).click()
    expect(onAncestorClick).not.toHaveBeenCalled()
  })

  it('mutation-check: drops aria-disabled and the sr-only description once enabled with onAction wired', () => {
    render(<CapabilityTeaser label="Merge" enabled={true} onAction={vi.fn()} />)
    const control = screen.getByRole('button', { name: 'Merge' })
    expect(control.getAttribute('aria-disabled')).toBeNull()
    expect(control.getAttribute('aria-describedby')).toBeNull()
    expect(screen.queryByText('Connect a daemon (MCP) to enable Merge')).toBeNull()
  })

  it('stays aria-disabled with a tooltip when enabled but no onAction is wired', () => {
    render(<CapabilityTeaser label="Merge" enabled={true} />)
    const control = screen.getByRole('button', { name: 'Merge' })
    expect(control.getAttribute('aria-disabled')).toBe('true')
    const describedById = control.getAttribute('aria-describedby')
    expect(describedById).toBeTruthy()
    const description = document.getElementById(describedById as string)
    expect(description?.textContent).toBe('This feature is not yet available')
  })

  it('does not call onAction when clicked while disabled', () => {
    const onAction = vi.fn()
    render(<CapabilityTeaser label="Merge" enabled={false} onAction={onAction} />)
    screen.getByRole('button', { name: 'Merge' }).click()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('does not call onAction when enabled but no onAction is wired', () => {
    render(<CapabilityTeaser label="Merge" enabled={true} />)
    screen.getByRole('button', { name: 'Merge' }).click()
  })

  it('calls onAction when enabled and onAction is wired', () => {
    const onAction = vi.fn()
    render(<CapabilityTeaser label="Merge" enabled={true} onAction={onAction} />)
    screen.getByRole('button', { name: 'Merge' }).click()
    expect(onAction).toHaveBeenCalledTimes(1)
  })
})
