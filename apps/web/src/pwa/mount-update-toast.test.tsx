import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('mountUpdateToast', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.resetModules()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('mounts the toast into a dedicated portal and reloads via the provided callback', async () => {
    const { mountUpdateToast } = await import('./mount-update-toast.js')
    const updateServiceWorker = vi.fn()

    mountUpdateToast(updateServiceWorker)

    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }))

    expect(updateServiceWorker).toHaveBeenCalledTimes(1)
    expect(updateServiceWorker).toHaveBeenCalledWith(true)
  })

  it('does not re-show the toast after Dismiss for the rest of the page lifetime', async () => {
    const { mountUpdateToast } = await import('./mount-update-toast.js')

    mountUpdateToast(vi.fn())
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/Update available/i)).toBeNull()

    // A second onNeedRefresh within the same page lifetime must stay hidden.
    mountUpdateToast(vi.fn())
    expect(screen.queryByText(/Update available/i)).toBeNull()
  })
})
