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
import { VERSION_LABEL_MAX_LENGTH, versionLabelSchema } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip.js'
import { BookmarkAction } from './BookmarkAction.js'

afterEach(() => cleanup())

type ActionProps = Partial<Parameters<typeof BookmarkAction>[0]>

function actionUi(props: ActionProps = {}) {
  return (
    <TooltipProvider>
      <BookmarkAction
        saving={props.saving ?? false}
        outcome={props.outcome ?? null}
        armed={props.armed ?? 0}
        onSave={props.onSave ?? (() => {})}
      />
    </TooltipProvider>
  )
}

function renderAction(props: ActionProps = {}) {
  return render(actionUi(props))
}

const openField = () => fireEvent.click(screen.getByTestId('bookmark-action'))
const nameField = () => screen.getByRole('textbox', { name: 'Name this point' }) as HTMLInputElement

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

  it('stops the name at the length a saved version accepts', () => {
    // A longer name would be refused by the daemon only after the field had
    // closed, so the person loses what they typed with no way to correct it.
    renderAction()
    fireEvent.click(screen.getByRole('button', { name: 'Bookmark this point' }))
    const field = screen.getByRole('textbox') as HTMLInputElement
    expect(field.maxLength).toBe(VERSION_LABEL_MAX_LENGTH)
    expect(versionLabelSchema.safeParse('x'.repeat(field.maxLength)).success).toBe(true)
    expect(versionLabelSchema.safeParse('x'.repeat(field.maxLength + 1)).success).toBe(false)
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

  it('puts the caret in the field it opens, from a press and from the shortcut', () => {
    // Otherwise the name typed next lands on the canvas as its shortcuts.
    const view = renderAction()
    openField()
    expect(document.activeElement).toBe(nameField())
    fireEvent.keyDown(nameField(), { key: 'Escape' })
    view.rerender(actionUi({ armed: 1 }))
    expect(document.activeElement).toBe(nameField())
  })

  it('does not bring an abandoned name back when the field reopens', () => {
    renderAction()
    openField()
    fireEvent.change(nameField(), { target: { value: 'half typed' } })
    fireEvent.keyDown(nameField(), { key: 'Escape' })
    openField()
    expect(nameField().value).toBe('')
  })

  it('does not bring a saved name back when the field reopens', () => {
    renderAction()
    openField()
    fireEvent.change(nameField(), { target: { value: 'first' } })
    fireEvent.keyDown(nameField(), { key: 'Enter' })
    openField()
    expect(nameField().value).toBe('')
  })

  it('saves the name without its surrounding spaces', () => {
    const onSave = vi.fn()
    renderAction({ onSave })
    openField()
    fireEvent.change(nameField(), { target: { value: '  before  ' } })
    fireEvent.keyDown(nameField(), { key: 'Enter' })
    expect(onSave).toHaveBeenCalledExactlyOnceWith('before')
  })

  it('opens nothing on a press while a bookmark is being saved, and says it is busy', () => {
    renderAction({ saving: true })
    openField()
    expect(screen.queryByRole('textbox')).toBeNull()
    const button = screen.getByRole('button', { name: 'Saving a bookmark…' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
  })

  it('drops a draft armed on the departed document when the page resets the arm', () => {
    const view = renderAction({ armed: 1 })
    fireEvent.change(nameField(), { target: { value: 'for the old document' } })
    view.rerender(actionUi({ armed: 0 }))
    view.rerender(actionUi({ armed: 1 }))
    expect(nameField().value).toBe('')
  })

  it('says a failure aloud and a success politely', () => {
    const view = renderAction({ outcome: 'failed' })
    expect(screen.getByRole('alert').textContent).toBe('Save failed')
    view.rerender(actionUi({ outcome: 'saved' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Bookmark saved')
  })
})
