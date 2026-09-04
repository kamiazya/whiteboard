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

export async function badKeystrokes() {
  await userEvent.keyboard('hello — world')
}

export function badTimers() {
  vi.useFakeTimers()
}
