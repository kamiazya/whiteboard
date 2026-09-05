import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

export async function good() {
  fireEvent.click(screen.getByRole('button'))
  await waitFor(() => {
    if (screen.queryByText('done') === null) throw new Error('not yet')
  })
}

export async function goodKeystrokes() {
  await userEvent.keyboard('hello world')
}

export function goodTimers() {
  vi.useFakeTimers()
}

import { it } from "vitest"

export const goodFocus = () => {
  it('plain, so every sibling still runs', () => {})
}
