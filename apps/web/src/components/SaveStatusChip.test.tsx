// The browser-local autosave state as a colored chip, modeled on the
// connection chip: a colored dot PLUS a visible text label (color alone
// must never carry the state — WCAG 1.4.1), with a popover carrying the
// sentence-shaped explanation.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SaveStatusChip } from './SaveStatusChip.js'

afterEach(cleanup)

const chip = (container: HTMLElement) =>
  container.querySelector('[data-testid="save-status-chip"]') as HTMLElement

it('shows Saved with the calm dot', () => {
  const { container } = render(<SaveStatusChip state={{ kind: 'saved', lastSavedAt: null }} />)
  expect(chip(container).textContent).toContain('Saved')
  expect(chip(container).querySelector('.bg-emerald-500')).toBeTruthy()
})

it('shows Saving… while a write is in flight', () => {
  const { container } = render(<SaveStatusChip state={{ kind: 'saving', lastSavedAt: null }} />)
  expect(chip(container).textContent).toContain('Saving…')
  expect(chip(container).querySelector('.bg-amber-500')).toBeTruthy()
})

it('shows Unsaved changes for a pending write', () => {
  const { container } = render(<SaveStatusChip state={{ kind: 'pending', lastSavedAt: null }} />)
  expect(chip(container).textContent).toContain('Unsaved changes')
})

it('degraded carries its own message as the visible label, with the attention pulse', () => {
  const { container } = render(
    <SaveStatusChip
      state={{
        kind: 'degraded',
        reason: 'quota',
        message: 'Storage is full',
        lastSavedAt: null,
      }}
    />,
  )
  expect(chip(container).textContent).toContain('Storage is full')
  expect(container.querySelector('[data-testid="save-status-chip-pulse"]')).toBeTruthy()
})

it('the popover explains the state as text on demand', () => {
  const { container, baseElement } = render(
    <SaveStatusChip state={{ kind: 'saved', lastSavedAt: null }} />,
  )
  fireEvent.click(chip(container))
  const popover = baseElement.querySelector('[data-testid="save-status-popover"]')
  expect(popover?.textContent).toContain('saved')
})
