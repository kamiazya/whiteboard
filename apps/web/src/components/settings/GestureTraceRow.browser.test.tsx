/**
 * The retrieval half of the gesture flight recorder: what leaves the device
 * is the serialized trace, it leaves only on the button, and what arrives is
 * replayable JSON rather than prose.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { gestureTrace, type TraceEntry } from '../../components/spatial-editor/gesture-trace.js'
import { GestureTraceRow } from './GestureTraceRow'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('copies the serialized trace: parseable, replayable entries plus the bundle identity', async () => {
  // Scoped by a pointerId this test minted: the singleton deliberately
  // outlives every test, so "the newest entry" would read a neighbour's.
  gestureTrace.recordDocPointer({
    at: 1,
    type: 'pointerdown',
    pointerId: 461,
    pointerType: 'touch',
    isPrimary: true,
    x: 10,
    y: 20,
    insideRoot: true,
    target: { tag: 'div' },
  })
  const written: string[] = []
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => {
    written.push(text)
  })

  render(<GestureTraceRow />)
  await userEvent.click(screen.getByRole('button', { name: 'Copy trace' }))

  expect(written).toHaveLength(1)
  const parsed = JSON.parse(written[0] ?? '') as {
    bundle: string
    userAgent: string
    entries: TraceEntry[]
  }
  expect(parsed.bundle.length).toBeGreaterThan(0)
  expect(parsed.userAgent.length).toBeGreaterThan(0)
  const mine = parsed.entries.filter(
    (entry) => entry.kind === 'doc-pointer' && entry.pointerId === 461,
  )
  expect(mine).toHaveLength(1)
  expect(await screen.findByText('copied')).toBeInTheDocument()
})

it('says so, rather than pretending, when the clipboard refuses', async () => {
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
  render(<GestureTraceRow />)
  await userEvent.click(screen.getByRole('button', { name: 'Copy trace' }))
  expect(await screen.findByText('copy failed')).toBeInTheDocument()
})
