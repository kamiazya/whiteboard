// @vitest-environment jsdom

/**
 * Marking the current state, from inside the history.
 *
 * The header's save dot is gone: it meant "you have edits no version holds
 * yet", and once checkpoints are taken automatically that state stops
 * existing — there is nothing to press it for. What remains is a different
 * act, naming a point worth coming back to, and a name is the whole value:
 * an unnamed bookmark is indistinguishable from the automatic checkpoint
 * beside it, because the row rewrite titles both by their time.
 *
 * So the control opens a field rather than saving on the spot.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip.js'
import { BookmarkAction } from './BookmarkAction.js'

afterEach(() => cleanup())

function renderAction(props: Partial<Parameters<typeof BookmarkAction>[0]> = {}) {
  return render(
    <TooltipProvider>
      <BookmarkAction
        saving={props.saving ?? false}
        outcome={props.outcome ?? null}
        armed={props.armed ?? 0}
        onSave={props.onSave ?? (() => {})}
      />
    </TooltipProvider>,
  )
}

describe('BookmarkAction', () => {
  it('is an icon with a name and no visible text', () => {
    renderAction()
    const button = screen.getByRole('button', { name: 'Bookmark this point' })
    expect(button.textContent).toBe('')
    expect(button.querySelector('svg')).not.toBeNull()
  })

  it('opens a name field rather than saving on the press', () => {
    const onSave = vi.fn()
    renderAction({ onSave })
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Bookmark this point' }))
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves the typed name on Enter', () => {
    const onSave = vi.fn()
    renderAction({ onSave })
    fireEvent.click(screen.getByRole('button', { name: 'Bookmark this point' }))
    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: 'before the rewrite' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onSave).toHaveBeenCalledWith('before the rewrite')
  })

  it('abandons the mark on Escape, leaving nothing behind', () => {
    const onSave = vi.fn()
    renderAction({ onSave })
    fireEvent.click(screen.getByRole('button', { name: 'Bookmark this point' }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('refuses an empty name, since an unnamed mark cannot be told from a checkpoint', () => {
    const onSave = vi.fn()
    renderAction({ onSave })
    fireEvent.click(screen.getByRole('button', { name: 'Bookmark this point' }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('opens the field when the page arms it, which is what the shortcut does', () => {
    const view = renderAction({ armed: 0 })
    expect(screen.queryByRole('textbox')).toBeNull()
    view.rerender(
      <TooltipProvider>
        <BookmarkAction saving={false} outcome={null} armed={1} onSave={() => {}} />
      </TooltipProvider>,
    )
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('closes the field when the page takes the arm back, rather than reading the reset as a press', () => {
    // The page zeroes `armed` on a document switch. Only an INCREASE is a
    // press: a field armed on the departed document and left open would
    // name the arrived one from that keystroke, so the reset closes it.
    const { rerender } = renderAction({ armed: 1 })
    expect(screen.getByRole('textbox', { name: 'Name this point' })).toBeTruthy()
    rerender(
      <TooltipProvider>
        <BookmarkAction saving={false} outcome={null} armed={0} onSave={() => {}} />
      </TooltipProvider>,
    )
    expect(screen.queryByRole('textbox', { name: 'Name this point' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Bookmark this point' })).toBeTruthy()
  })
})
