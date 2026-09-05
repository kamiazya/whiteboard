import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, vi } from 'vitest'

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


export function goodTimers() {
  vi.useFakeTimers()
}

import { it } from "vitest"

export const goodFocus = () => {
  it('plain, so every sibling still runs', () => {})
}

export async function goodAwaited() {
  await expect(Promise.resolve(1)).resolves.toBe(1)
  await expect('snapshot').toMatchFileSnapshot('./out.txt')
}

export function goodReturned() {
  return expect(Promise.resolve(1)).resolves.toBe(1)
}

export const goodTitle = () => {
  it('rejects a malformed prefix and keeps the issue count at zero', () => {})
}
