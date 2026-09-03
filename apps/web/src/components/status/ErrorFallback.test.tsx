/**
 * The recovery action has to be able to recover.
 *
 * "Try again" resets the boundary in place, which is right for a transient
 * render failure. "Reload" is for the other kind — the bundle itself is
 * wrong — and under a `prompt`-registered worker that means it must drop the
 * worker, not merely navigate.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const reloadFresh = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../../pwa/reload-fresh.js', () => ({ reloadFresh }))

const { ErrorFallback } = await import('./ErrorFallback.js')

// The spy is module-level, so a call from the previous test would otherwise
// be counted as this one's.
beforeEach(() => reloadFresh.mockClear())

it('reloads through the worker-dropping path, not a plain navigation', () => {
  const onRetry = vi.fn()
  render(<ErrorFallback onRetry={onRetry} />)

  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))

  expect(reloadFresh).toHaveBeenCalledTimes(1)
  expect(onRetry).not.toHaveBeenCalled()
})

it('keeps Try again as the in-place retry, which must not reload anything', () => {
  const onRetry = vi.fn()
  render(<ErrorFallback onRetry={onRetry} />)

  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

  expect(onRetry).toHaveBeenCalledTimes(1)
  expect(reloadFresh).not.toHaveBeenCalled()
})
