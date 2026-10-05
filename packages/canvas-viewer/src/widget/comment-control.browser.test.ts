// The comment control's failure line, in a real browser: the form is a flex
// row inside a narrow fixed frame, and only real layout says whether the
// alert gets a row of its own and whether the field really stops at the bound.

import { COMMENT_MESSAGE_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { afterEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { COMMENT_INPUT_TEST_ID, createCommentControl } from './comment-control.js'

function parts(form: HTMLFormElement) {
  return {
    input: form.querySelector<HTMLInputElement>(`[data-testid="${COMMENT_INPUT_TEST_ID}"]`)!,
    alert: form.querySelector<HTMLElement>('[role="alert"]')!,
  }
}

describe('comment control failure line (real browser)', () => {
  // biome-ignore lint/plugin: createCommentControl is plain DOM, no React root
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows the reason on its own row below the field, inside the form', () => {
    const control = createCommentControl(() => {})
    control.show()
    control.setAnchor('(10, 20)')
    control.setError(
      'a comment message is longer than the 4096-character limit; split it across replies',
    )
    const { input, alert } = parts(control.element)
    const alertBox = alert.getBoundingClientRect()
    const inputBox = input.getBoundingClientRect()
    const formBox = control.element.getBoundingClientRect()
    expect(alertBox.height).toBeGreaterThan(0)
    expect(alertBox.top).toBeGreaterThanOrEqual(inputBox.bottom)
    expect(alertBox.left).toBeGreaterThanOrEqual(formBox.left)
    expect(alertBox.right).toBeLessThanOrEqual(formBox.right)
  })

  it('a keystroke clears the reason', async () => {
    const control = createCommentControl(() => {})
    control.show()
    control.setError('refused')
    const { input, alert } = parts(control.element)
    await userEvent.type(input, 'a')
    expect(alert.hidden).toBe(true)
    expect(alert.getBoundingClientRect().height).toBe(0)
  })

  it('stops typing at the message bound', async () => {
    const control = createCommentControl(() => {})
    control.show()
    const { input } = parts(control.element)
    input.value = 'x'.repeat(COMMENT_MESSAGE_MAX_CHARS - 1)
    await userEvent.type(input, 'abc')
    expect(input.value.length).toBe(COMMENT_MESSAGE_MAX_CHARS)
  })
})
