import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  document.body.innerHTML = ''
})

export async function bad() {
  await waitFor(() => {
    fireEvent.click(screen.getByRole('button'))
  })
}
