import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { announceOnCanvas } from '../../lib/canvas-announcer.js'
import { CanvasAnnouncerRegion } from './CanvasAnnouncerRegion.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('speaks an announcement into the status region that was already mounted, then clears it', () => {
  render(<CanvasAnnouncerRegion />)
  const region = screen.getByRole('status')
  expect(region.textContent).toBe('')
  act(() => announceOnCanvas('Tidied'))
  expect(region.textContent).toBe('Tidied')
  act(() => {
    vi.advanceTimersByTime(2500)
  })
  expect(region.textContent).toBe('')
})
