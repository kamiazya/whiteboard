import { fireEvent, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  document.body.innerHTML = ''
})

export async function bad() {
  await waitFor(() => {
    fireEvent.click(screen.getByRole('button'))
  })
}


export function badTimers() {
  vi.useFakeTimers()
}

// biome-ignore lint/suspicious/noExportsInTest: fixture, never executed
export const badFocus = () => {
  it.only('focused, so the rest of this file never runs', () => {})
}
