import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinkTarget } from '../../lib/link-target.js'
import { LinkPickerDialog } from './LinkPickerDialog.js'

afterEach(cleanup)

const alpha: LinkTarget = { id: '01A', path: 'alpha', name: 'Alpha', kind: 'markdown' }
const beta: LinkTarget = { id: '01B', path: 'beta', name: 'Beta', kind: 'markdown' }

function mount(initialQuery = '') {
  const onPick = vi.fn<(markup: string) => void>()
  const onCancel = vi.fn()
  const view = render(
    <LinkPickerDialog
      targets={[alpha, beta]}
      initialQuery={initialQuery}
      linkText=""
      onPick={onPick}
      onCancel={onCancel}
    />,
  )
  const box = () => screen.getByRole('combobox')
  /** Answers what `dispatchEvent` does: false when the default was prevented. */
  const key = (k: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(box(), { key: k, ...init })
  const picked = () => onPick.mock.calls.map(([markup]) => markup)
  return { onPick, onCancel, view, box, key, picked }
}

/**
 * The fast path the picker exists for is one Enter on whatever is
 * highlighted, so the highlight must always sit on a real row: arrows stop at
 * the ends rather than walking off them, and a new query starts from the top.
 */
describe('the highlighted row is always one Enter can link', () => {
  it('stays on the first row when ArrowUp is pressed there', () => {
    const { key, picked } = mount()
    key('ArrowUp')
    key('Enter')
    expect(picked()).toHaveLength(1)
    expect(picked()[0]).toContain('alpha')
  })

  it('stops at the last row, so an overshoot costs no extra ArrowUp', () => {
    const { key, picked } = mount()
    key('ArrowDown')
    key('ArrowDown')
    key('ArrowDown')
    key('ArrowUp')
    key('Enter')
    expect(picked()).toHaveLength(1)
    expect(picked()[0]).toContain('alpha')
  })

  it('goes back to the first result when the query changes', () => {
    const { key, box, picked } = mount()
    key('ArrowDown')
    fireEvent.change(box(), { target: { value: 'a' } })
    key('Enter')
    expect(picked()[0]).toContain('alpha')
  })

  it('follows the list when it shrinks under the highlight', () => {
    const { key, view, onPick, onCancel, picked } = mount()
    key('ArrowDown')
    view.rerender(
      <LinkPickerDialog
        targets={[alpha]}
        initialQuery=""
        linkText=""
        onPick={onPick}
        onCancel={onCancel}
      />,
    )
    key('Enter')
    expect(picked()).toHaveLength(1)
    expect(picked()[0]).toContain('alpha')
  })

  it('moves the highlight with the arrow keys instead of the caret', () => {
    const { key } = mount()
    expect(key('ArrowDown')).toBe(false)
    expect(key('ArrowUp')).toBe(false)
  })
})

describe('keys the picker must not pass on', () => {
  /** The Enter that confirms a CJK conversion is part of typing the query. */
  it('links nothing on an Enter that belongs to an IME composition', () => {
    const { key, onPick } = mount()
    key('Enter', { isComposing: true })
    key('Enter', { keyCode: 229 })
    expect(onPick).not.toHaveBeenCalled()
  })

  /** Escape closes the picker, not the editor the picker was opened from. */
  it('closes on Escape without the Escape reaching anything around it', () => {
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    try {
      const { key, onCancel } = mount()
      key('Escape')
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(outer).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', outer)
    }
  })
})

it('trims the display text of an external link', () => {
  const { key, picked } = mount('https://example.com/x')
  fireEvent.change(screen.getByLabelText('Text'), { target: { value: '  Notes  ' } })
  key('Enter')
  expect(picked()).toEqual(['[Notes](https://example.com/x)'])
})
