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

  // Putting it off leaves a chip rather than nothing: an update nobody can
  // find again is how a page keeps running old code for the rest of its life.
  // What must not happen is the expanded form reopening on its own.
  it('leaves a persistent chip after Later, and does not reopen on a later refresh', async () => {
    const { mountUpdateToast } = await import('./mount-update-toast.js')

    mountUpdateToast(vi.fn())
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
    expect(screen.getByRole('button', { name: /Update available/i })).toBeTruthy()

    mountUpdateToast(vi.fn())
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
    expect(screen.getByRole('button', { name: /Update available/i })).toBeTruthy()
  })

  it('reuses the existing root when onNeedRefresh fires again before dismiss', async () => {
    const { mountUpdateToast } = await import('./mount-update-toast.js')
    const firstUpdateServiceWorker = vi.fn()
    const secondUpdateServiceWorker = vi.fn()

    mountUpdateToast(firstUpdateServiceWorker)
    await screen.findByRole('button', { name: 'Reload' })

    // A second SW update notification arrives before the user dismisses or
    // reloads. Re-mounting must not throw (React's createRoot() called
    // twice on the same container warns and can corrupt the fiber tree) and
    // must still render exactly one toast wired to the latest callback.
    expect(() => mountUpdateToast(secondUpdateServiceWorker)).not.toThrow()
    const reloadButtons = await screen.findAllByRole('button', { name: 'Reload' })
    expect(reloadButtons).toHaveLength(1)

    fireEvent.click(reloadButtons[0] as HTMLElement)
    expect(firstUpdateServiceWorker).not.toHaveBeenCalled()
    expect(secondUpdateServiceWorker).toHaveBeenCalledTimes(1)
    expect(secondUpdateServiceWorker).toHaveBeenCalledWith(true)
  })
})
