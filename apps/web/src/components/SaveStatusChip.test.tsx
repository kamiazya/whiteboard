// The browser keeper's autosave state as a color-only dot beside the title
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

/**
 * A document that has never been written and one whose write just landed are
 * BOTH `Saved`, and the accessible name is identical for the two.
 *
 * That is correct for a person — "Saved" is what they want to read either way
 * — but it makes the name useless as a test's proof that a write completed.
 * Two browser tests waited on `getByRole('button', { name: 'Saved' })` for
 * exactly that, one of them under a comment calling it "the page's own report
 * that the write completed". It matched the state the page was already in, so
 * they navigated away with the debounced write still pending and read the
 * loss later as lost keystrokes.
 *
 * `data-last-saved-at` is the discriminator that was missing: absent until a
 * write has actually landed for this document.
 */
it('distinguishes a landed write from having never written, which the name cannot', () => {
  const neverWritten = render(<SaveStatusChip state={{ kind: 'saved', lastSavedAt: null }} />)
  const landed = render(
    <SaveStatusChip state={{ kind: 'saved', lastSavedAt: '2026-01-01T00:00:00.000Z' }} />,
  )
  const [first, second] = [neverWritten, landed].map((r) => chip(r.container))

  // Identical to a reader, by design.
  expect(first!.getAttribute('aria-label')).toBe(second!.getAttribute('aria-label'))

  // Distinguishable to a test.
  expect(first!.getAttribute('data-last-saved-at')).toBeNull()
  expect(second!.getAttribute('data-last-saved-at')).toBe('2026-01-01T00:00:00.000Z')
})

it('publishes the state kind, so a wait can require a transition rather than a label', () => {
  for (const kind of ['saved', 'saving', 'pending'] as const) {
    cleanup()
    const { container } = render(<SaveStatusChip state={{ kind, lastSavedAt: null }} />)
    expect(chip(container).getAttribute('data-save-state')).toBe(kind)
  }
})
