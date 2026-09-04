import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})

export async function good() {
  fireEvent.click(screen.getByRole('button'))
  await waitFor(() => {
    if (screen.queryByText('done') === null) throw new Error('not yet')
  })
}
