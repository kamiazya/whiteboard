import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeaderSaveDot } from './HeaderSaveDot.js'
import { TooltipProvider } from './ui/tooltip.js'

afterEach(() => cleanup())

// Tooltip needs the Radix provider to avoid warnings in tests.
function renderDot(props: Parameters<typeof HeaderSaveDot>[0]) {
  return render(
    <TooltipProvider>
      <HeaderSaveDot {...props} />
    </TooltipProvider>,
  )
}

describe('HeaderSaveDot', () => {
  it('renders nothing when dirty=false and saving=false', () => {
    const { container } = renderDot({ dirty: false, saving: false, onSave: () => {} })
    expect(container.querySelector('[data-testid="header-save-dot"]')).toBeNull()
  })

  it('renders the amber dot when dirty=true', () => {
    renderDot({ dirty: true, saving: false, onSave: () => {} })
    const dot = screen.getByTestId('header-save-dot')
    expect(dot).not.toBeNull()
    expect(dot.getAttribute('aria-label')).toBe('Unsaved changes')
  })

  it('shows "Saving…" aria text and marks the button aria-disabled when saving=true', () => {
    renderDot({ dirty: true, saving: true, onSave: () => {} })
    const dot = screen.getByTestId('header-save-dot')
    expect(dot.getAttribute('aria-label')).toBe('Saving…')
    expect(dot.getAttribute('aria-disabled')).toBe('true')
  })

  it('calls onSave on click', () => {
    const onSave = vi.fn()
    renderDot({ dirty: true, saving: false, onSave })
    act(() => {
      fireEvent.click(screen.getByTestId('header-save-dot'))
    })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('blocks clicks while saving without using the disabled attribute (keeps the tooltip reachable)', () => {
    // A natively disabled button inside a Radix TooltipTrigger swallows the
    // pointer events the tooltip needs, so "Saving…" would never show on
    // hover. aria-disabled + a click guard keeps both behaviors.
    const onSave = vi.fn()
    renderDot({ dirty: true, saving: true, onSave })
    const dot = screen.getByTestId('header-save-dot')
    expect(dot.hasAttribute('disabled')).toBe(false)
    expect(dot.getAttribute('aria-disabled')).toBe('true')
    act(() => {
      fireEvent.click(dot)
    })
    expect(onSave).not.toHaveBeenCalled()
  })
})
