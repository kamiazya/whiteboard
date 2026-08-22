import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeaderVersionDot } from './HeaderVersionDot.js'
import { TooltipProvider } from './ui/tooltip.js'

afterEach(() => cleanup())

// Tooltip needs the Radix provider to avoid warnings in tests.
function renderDot(props: Parameters<typeof HeaderVersionDot>[0]) {
  return render(
    <TooltipProvider>
      <HeaderVersionDot {...props} />
    </TooltipProvider>,
  )
}

describe('HeaderVersionDot', () => {
  it('renders nothing when dirty=false and saving=false', () => {
    const { container } = renderDot({ dirty: false, saving: false, onSave: () => {} })
    expect(container.querySelector('[data-testid="header-version-dot"]')).toBeNull()
  })

  it('appears when dirty=true', () => {
    renderDot({ dirty: true, saving: false, onSave: () => {} })
    const dot = screen.getByTestId('header-version-dot')
    expect(dot).not.toBeNull()
    expect(dot.getAttribute('aria-label')).toBe('No version saved yet')
  })

  it('reports the in-flight save and marks the button aria-disabled when saving=true', () => {
    renderDot({ dirty: true, saving: true, onSave: () => {} })
    const dot = screen.getByTestId('header-version-dot')
    expect(dot.getAttribute('aria-label')).toBe('Saving a version…')
    expect(dot.getAttribute('aria-disabled')).toBe('true')
  })

  it('calls onSave on click', () => {
    const onSave = vi.fn()
    renderDot({ dirty: true, saving: false, onSave })
    act(() => {
      fireEvent.click(screen.getByTestId('header-version-dot'))
    })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('blocks clicks while saving without using the disabled attribute (keeps the tooltip reachable)', () => {
    // A natively disabled button inside a Radix TooltipTrigger swallows the
    // pointer events the tooltip needs, so "Saving…" would never show on
    // hover. aria-disabled + a click guard keeps both behaviors.
    const onSave = vi.fn()
    renderDot({ dirty: true, saving: true, onSave })
    const dot = screen.getByTestId('header-version-dot')
    expect(dot.hasAttribute('disabled')).toBe(false)
    expect(dot.getAttribute('aria-disabled')).toBe('true')
    act(() => {
      fireEvent.click(dot)
    })
    expect(onSave).not.toHaveBeenCalled()
  })
})

// `useDirtyState` tracks edits since the last NAMED VERSION — its own comment
// says so — not whether content reached storage. Calling this a save dot, and
// dressing it in the same filled amber the real persistence dot uses, is what
// makes the same shape mean two different things across modes.
describe('the version dot does not impersonate the save dot', () => {
  it('names the version, not a save', () => {
    render(<HeaderVersionDot dirty={true} saving={false} onSave={() => {}} />)
    const dot = screen.getByTestId('header-version-dot')
    expect(dot.getAttribute('aria-label')).toBe('No version saved yet')
  })

  it('renders as a ring rather than the filled disc the save state owns', () => {
    const { container } = render(<HeaderVersionDot dirty={true} saving={false} onSave={() => {}} />)
    expect(container.querySelector('.bg-amber-500')).toBeNull()
    expect(container.querySelector('.border-amber-500')).toBeTruthy()
  })
})
