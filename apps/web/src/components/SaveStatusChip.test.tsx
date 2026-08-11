// The browser-local autosave state as a color-only dot beside the title
// (owner decision): the label lives in the accessible name and tooltip,
// the sentence-shaped explanation in a popover — assistive tech always
// gets the state as text even though sighted glances read color alone.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SaveStatusChip } from './SaveStatusChip.js'

afterEach(cleanup)

const chip = (container: HTMLElement) =>
  container.querySelector('[data-testid="save-status-chip"]') as HTMLElement

it('names Saved accessibly while showing only the calm dot', () => {
  const { container } = render(<SaveStatusChip state={{ kind: 'saved', lastSavedAt: null }} />)
  expect(chip(container).getAttribute('aria-label')).toBe('Saved')
  // Color-only on the surface: no visible words on the dot itself.
  expect(chip(container).textContent).toBe('')
  expect(chip(container).querySelector('.bg-emerald-500')).toBeTruthy()
})

it('names Saving… while a write is in flight', () => {
  const { container } = render(<SaveStatusChip state={{ kind: 'saving', lastSavedAt: null }} />)
  expect(chip(container).getAttribute('aria-label')).toBe('Saving…')
  expect(chip(container).querySelector('.bg-amber-500')).toBeTruthy()
})

it('names Unsaved changes for a pending write', () => {
  const { container } = render(<SaveStatusChip state={{ kind: 'pending', lastSavedAt: null }} />)
  expect(chip(container).getAttribute('aria-label')).toBe('Unsaved changes')
})

it('degraded carries its own message as the accessible name, with the attention pulse', () => {
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
  expect(chip(container).getAttribute('aria-label')).toBe('Storage is full')
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
