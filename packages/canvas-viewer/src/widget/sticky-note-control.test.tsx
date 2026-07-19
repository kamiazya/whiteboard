import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStickyNoteControl,
  STICKY_NOTE_CONTROL_TEST_ID,
  STICKY_NOTE_INPUT_TEST_ID,
  STICKY_NOTE_SUBMIT_TEST_ID,
} from './sticky-note-control.js'

function queryControl(): HTMLElement | null {
  return document.querySelector(`[data-testid="${STICKY_NOTE_CONTROL_TEST_ID}"]`)
}

function queryInput(): HTMLInputElement | null {
  return document.querySelector(`[data-testid="${STICKY_NOTE_INPUT_TEST_ID}"]`)
}

function querySubmit(): HTMLButtonElement | null {
  return document.querySelector(`[data-testid="${STICKY_NOTE_SUBMIT_TEST_ID}"]`)
}

describe('createStickyNoteControl', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders hidden as a sibling of #root, not inside it', () => {
    createStickyNoteControl(() => {})
    const control = queryControl()
    expect(control).not.toBeNull()
    expect(control?.parentElement).toBe(document.body)
    expect(document.getElementById('root')?.contains(control ?? null)).toBe(false)
    expect(control?.style.display).toBe('none')
  })

  it('show() reveals the control', () => {
    const control = createStickyNoteControl(() => {})
    control.show()
    expect(queryControl()?.style.display).not.toBe('none')
  })

  it('submitting non-empty text calls onSubmit with the trimmed text exactly once', () => {
    const onSubmit = vi.fn()
    const control = createStickyNoteControl(onSubmit)
    control.show()

    const input = queryInput() as HTMLInputElement
    input.value = '  hello sticky  '
    ;(queryControl() as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('hello sticky')
  })

  it('submitting empty or whitespace-only text is a no-op', () => {
    const onSubmit = vi.fn()
    const control = createStickyNoteControl(onSubmit)
    control.show()

    const input = queryInput() as HTMLInputElement
    input.value = '   '
    ;(queryControl() as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('setBusy(true) disables the input and submit button; setBusy(false) re-enables them', () => {
    const control = createStickyNoteControl(() => {})
    control.setBusy(true)
    expect(queryInput()?.disabled).toBe(true)
    expect(querySubmit()?.disabled).toBe(true)

    control.setBusy(false)
    expect(queryInput()?.disabled).toBe(false)
    expect(querySubmit()?.disabled).toBe(false)
  })

  it('survives a container replaceChildren() remount because it lives outside #root', () => {
    createStickyNoteControl(() => {})
    const root = document.getElementById('root') as HTMLElement
    root.replaceChildren(document.createElement('span'))
    expect(queryControl()).not.toBeNull()
  })
})
