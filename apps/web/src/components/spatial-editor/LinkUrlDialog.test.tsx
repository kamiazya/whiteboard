// Why the OK button is dead, said out loud.
//
// The dialog used to disable OK and explain nothing: a disabled button is
// not focusable, so someone on a screen reader could not even reach the
// control that was refusing them, let alone learn why. The two ways to be
// invalid need different sentences — "that is not an address" and "that
// address is one we will not open" are different problems with different
// fixes.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { LinkUrlDialog } from './LinkUrlDialog.js'

afterEach(cleanup)

function renderDialog() {
  const submitted: string[] = []
  const { container } = render(
    <LinkUrlDialog title="Add Link" onSubmit={(url) => submitted.push(url)} onCancel={() => {}} />,
  )
  const input = container.querySelector('input') as HTMLInputElement
  const ok = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'OK',
  ) as HTMLButtonElement
  return { container, input, ok, submitted }
}

it('says nothing while the field is still empty', () => {
  const { container, ok } = renderDialog()

  // An untouched field is not a mistake, and an error sitting there before
  // anyone has typed reads as a broken dialog.
  expect(container.querySelector('[data-testid="link-url-error"]')).toBeNull()
  expect(ok.disabled).toBe(true)
})

it('explains what is missing when the text is not an address at all', () => {
  const { input } = renderDialog()

  fireEvent.change(input, { target: { value: 'example.com' } })

  const error = screen.getByTestId('link-url-error')
  expect(error.textContent).toMatch(/https:\/\//)
})

it('explains the refusal separately when the address is one we will not open', () => {
  const { input, ok } = renderDialog()

  fireEvent.change(input, { target: { value: 'javascript:alert(1)' } })

  // A parseable URL we decline to follow is a different problem from a typo,
  // and telling someone to "add https://" here would be wrong advice — they
  // typed a complete address; it is the scheme we refuse.
  const refusal = screen.getByTestId('link-url-error').textContent
  expect(refusal).not.toMatch(/starting with/i)
  expect(refusal).toMatch(/only/i)
  expect(ok.disabled).toBe(true)

  // And the two failures must not collapse into one sentence.
  fireEvent.change(input, { target: { value: 'example.com' } })
  expect(screen.getByTestId('link-url-error').textContent).not.toBe(refusal)
})

it('wires the message to the field so it is announced, not just painted', () => {
  const { input } = renderDialog()

  fireEvent.change(input, { target: { value: 'nope' } })

  const error = screen.getByTestId('link-url-error')
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(input.getAttribute('aria-describedby')).toBe(error.id)
  expect(error.id).not.toBe('')
})

it('takes the message back down once the address is usable', () => {
  const { input, ok } = renderDialog()

  fireEvent.change(input, { target: { value: 'nope' } })
  fireEvent.change(input, { target: { value: 'https://example.com' } })

  expect(screen.queryByTestId('link-url-error')).toBeNull()
  expect(input.getAttribute('aria-invalid')).toBe('false')
  expect(ok.disabled).toBe(false)
})
