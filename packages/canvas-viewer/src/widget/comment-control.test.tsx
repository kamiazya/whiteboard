import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMMENT_ANCHOR_TEST_ID,
  COMMENT_INPUT_TEST_ID,
  COMMENT_SUBMIT_TEST_ID,
  createCommentControl,
} from './comment-control.js'

function input(control: { element: HTMLFormElement }): HTMLInputElement {
  return control.element.querySelector(
    `[data-testid="${COMMENT_INPUT_TEST_ID}"]`,
  ) as HTMLInputElement
}

function submitButton(control: { element: HTMLFormElement }): HTMLButtonElement {
  return control.element.querySelector(
    `[data-testid="${COMMENT_SUBMIT_TEST_ID}"]`,
  ) as HTMLButtonElement
}

function anchorHint(control: { element: HTMLFormElement }): HTMLElement {
  return control.element.querySelector(`[data-testid="${COMMENT_ANCHOR_TEST_ID}"]`) as HTMLElement
}

function submitForm(control: { element: HTMLFormElement }): void {
  control.element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

describe('createCommentControl', () => {
  // biome-ignore lint/plugin: createCommentControl is plain DOM, no React root
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('starts hidden, anchorless, and with submit disabled — a comment needs a spot first', () => {
    const control = createCommentControl(() => {})
    expect(control.element.style.display).toBe('none')
    expect(submitButton(control).disabled).toBe(true)
    expect(anchorHint(control).textContent).toContain('Click the canvas')
  })

  it('setAnchor enables submit and names the spot; clearing it disables again', () => {
    const onSubmit = vi.fn()
    const control = createCommentControl(onSubmit)
    control.setAnchor('(120, 40)')
    expect(submitButton(control).disabled).toBe(false)
    expect(anchorHint(control).textContent).toBe('(120, 40)')

    input(control).value = 'looks off'
    submitForm(control)
    expect(onSubmit).toHaveBeenCalledWith('looks off')

    control.setAnchor(undefined)
    expect(submitButton(control).disabled).toBe(true)
    submitForm(control)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('never submits empty or whitespace-only text, and trims what it submits', () => {
    const onSubmit = vi.fn()
    const control = createCommentControl(onSubmit)
    control.setAnchor('(0, 0)')

    input(control).value = '   '
    submitForm(control)
    expect(onSubmit).not.toHaveBeenCalled()

    input(control).value = '  fix this  '
    submitForm(control)
    expect(onSubmit).toHaveBeenCalledWith('fix this')
  })

  it('busy disables submit even with an anchor, and releases without losing the anchor', () => {
    const onSubmit = vi.fn()
    const control = createCommentControl(onSubmit)
    control.setAnchor('(5, 5)')
    control.setBusy(true)
    expect(submitButton(control).disabled).toBe(true)
    input(control).value = 'queued'
    submitForm(control)
    expect(onSubmit).not.toHaveBeenCalled()

    control.setBusy(false)
    expect(submitButton(control).disabled).toBe(false)
    submitForm(control)
    expect(onSubmit).toHaveBeenCalledWith('queued')
  })
})
