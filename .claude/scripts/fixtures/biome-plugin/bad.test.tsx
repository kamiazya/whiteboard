import { fireEvent, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, vi } from 'vitest'

afterEach(() => {
  document.body.innerHTML = ''
})

export async function bad() {
  await waitFor(() => {
    fireEvent.click(screen.getByRole('button'))
  })
}

export async function badKeystrokes() {
  await userEvent.keyboard('hello — world')
}

export function badTimers() {
  vi.useFakeTimers()
}

// biome-ignore lint/suspicious/noExportsInTest: fixture, never executed
export const badFocus = () => {
  it.only('focused, so the rest of this file never runs', () => {})
}

export async function badUnawaited() {
  expect(Promise.resolve(1)).resolves.toBe(1)
  expect('snapshot').toMatchFileSnapshot('./out.txt')
}

// biome-ignore lint/suspicious/noExportsInTest: fixture, never executed
export const badChronology = () => {
  it('regression for PR #1234, pre-fix behaviour', () => {})
}
