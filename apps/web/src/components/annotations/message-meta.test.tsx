import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MessageBy } from './message-meta.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-05T10:00:00.000Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('stamps a fresh message by its age, the way every other stamp in the app reads', () => {
  render(<MessageBy message={{ id: 'm', body: 'x', createdAt: '2026-09-05T08:00:00.000Z' }} />)
  expect(screen.getByText('2h ago')).not.toBeNull()
})

it('stamps an older message in the READER’S clock, not UTC, keeping the original machine-readable', () => {
  const iso = '2026-09-01T15:04:00.000Z'
  render(<MessageBy message={{ id: 'm', body: 'x', createdAt: iso }} />)
  // The platform's own local-time getters are the expectation: whatever
  // zone this runner sits in, the label must agree with them.
  const local = new Date(iso)
  const two = (n: number) => String(n).padStart(2, '0')
  const expected = `${local.getMonth() + 1}/${local.getDate()} ${two(local.getHours())}:${two(local.getMinutes())}`
  const time = screen.getByText(expected)
  expect(time.tagName).toBe('TIME')
  expect(time.getAttribute('datetime')).toBe(iso)
})

it('renders nothing at all for a message with neither author nor stamp', () => {
  const { container } = render(<MessageBy message={{ id: 'm', body: 'x' }} />)
  expect(container.childElementCount).toBe(0)
})
