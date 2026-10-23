import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LayoutStatus } from './LayoutStatus.js'

const LAYOUT_STATUS_DELAY_MS = 300

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('says nothing for a layout that finishes inside the delay', () => {
  const { rerender } = render(<LayoutStatus current={false} />)
  act(() => vi.advanceTimersByTime(LAYOUT_STATUS_DELAY_MS - 1))
  rerender(<LayoutStatus current />)
  act(() => vi.advanceTimersByTime(LAYOUT_STATUS_DELAY_MS * 2))
  expect(screen.queryByText('Laying out…')).toBeNull()
})

it('announces a layout still running after the delay, in a polite region that was already mounted', () => {
  render(<LayoutStatus current={false} />)
  const region = screen.getByTestId('layout-status')
  expect(region.getAttribute('aria-live')).toBe('polite')
  act(() => vi.advanceTimersByTime(LAYOUT_STATUS_DELAY_MS))
  expect(region.textContent).toContain('Laying out…')
})

it('clears once the scene is current', () => {
  const { rerender } = render(<LayoutStatus current={false} />)
  act(() => vi.advanceTimersByTime(LAYOUT_STATUS_DELAY_MS))
  rerender(<LayoutStatus current />)
  expect(screen.queryByText('Laying out…')).toBeNull()
})
