/**
 * The History panel's save affordance, held to the repo's icon-first rule
 * for object actions (DESIGN.md, "Object-action surfaces are icon-first"):
 * the verb renders as a symbol, and its NAME is carried by `aria-label` —
 * "no visible text" being a visual statement only.
 *
 * Asserted here rather than left to review because the control this
 * replaces drew its verb as visible text on BOTH document pages, from two
 * copies of the same JSX. One component, one rule, one place to check it.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip.js'
import { SaveVersionAction, type SaveVersionOutcome } from './SaveVersionAction.js'

afterEach(() => cleanup())

function renderAction(props: {
  saving?: boolean
  outcome?: SaveVersionOutcome
  onSave?: () => void
}) {
  return render(
    <TooltipProvider>
      <SaveVersionAction
        saving={props.saving ?? false}
        outcome={props.outcome ?? null}
        onSave={props.onSave ?? (() => {})}
      />
    </TooltipProvider>,
  )
}

describe('SaveVersionAction', () => {
  it('names the verb without drawing it — an icon with an accessible name and no visible text', () => {
    renderAction({})
    const button = screen.getByRole('button', { name: 'Save version' })
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).not.toBeNull()
  })

  it('calls onSave on click', () => {
    const onSave = vi.fn()
    renderAction({ onSave })
    screen.getByRole('button', { name: 'Save version' }).click()
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('reports an in-flight save through the icon and aria-disabled, and swallows the click', () => {
    const onSave = vi.fn()
    renderAction({ saving: true, onSave })
    const button = screen.getByRole('button', { name: 'Saving a version…' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.textContent).toBe('')
    button.click()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('announces a save to a screen reader only — the row that appears is the visible answer', () => {
    renderAction({ outcome: 'saved' })
    const announced = screen.getByText(/version saved/i)
    expect(announced.className).toContain('sr-only')
    expect(screen.getByRole('button', { name: 'Save version' }).textContent).toBe('')
  })

  it('draws a failure as a short visible alert, never a sentence sitting in the chrome', () => {
    renderAction({ outcome: 'failed' })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('Save failed')
    expect(alert.className).not.toContain('sr-only')
  })
})
