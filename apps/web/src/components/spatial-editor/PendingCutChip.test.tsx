import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PendingCutChip } from './PendingCutChip.js'

afterEach(cleanup)

it('tells coarse pointers how to place; mice get the count only', () => {
  render(<PendingCutChip count={2} coarse onCancel={vi.fn()} />)
  expect(screen.getByTestId('pending-cut-chip').textContent).toContain('2 held — tap to place')
  cleanup()
  render(<PendingCutChip count={1} coarse={false} onCancel={vi.fn()} />)
  const chip = screen.getByTestId('pending-cut-chip')
  expect(chip.textContent).toContain('1 held')
  expect(chip.textContent).not.toContain('tap to place')
})

it('the ✕ carries an accessible name and fires onCancel', () => {
  const onCancel = vi.fn()
  render(<PendingCutChip count={1} coarse onCancel={onCancel} />)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel cut' }))
  expect(onCancel).toHaveBeenCalledTimes(1)
})
