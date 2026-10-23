import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MessageBy } from './message-meta.js'

afterEach(cleanup)

const BASE = { id: 'm1', body: 'tighten', createdAt: '2026-09-05T08:00:00.000Z' }

it('marks a message that has been rewritten', () => {
  render(<MessageBy message={{ ...BASE, editedAt: '2026-09-05T09:00:00.000Z' }} unsignedAs="You" />)
  expect(screen.getByText('(edited)')).not.toBeNull()
})

it('says nothing extra about a message nobody has rewritten', () => {
  render(<MessageBy message={BASE} unsignedAs="You" />)
  expect(screen.queryByText('(edited)')).toBeNull()
})
