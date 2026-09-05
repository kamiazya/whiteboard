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

// Advances per EXECUTION, not per test: the singleton trace outlives every
// test AND every repeat — vitest --repeats (CI's stress job) re-runs the body
// in the same process, so a constant minted id accumulates one entry per
// repeat and `toHaveLength(1)` reads its own earlier runs as duplicates
// (observed: 4 entries on the stress job's later repeats).
let nextProbePointerId = 461

it('copies the serialized trace: parseable, replayable entries plus the bundle identity', async () => {
  // Scoped by a pointerId this execution minted: unique against neighbour
  // tests and against earlier repeats of this same test alike.
  const probePointerId = nextProbePointerId++
  gestureTrace.recordDocPointer({
    at: 1,
    type: 'pointerdown',
    pointerId: probePointerId,
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
    (entry) => entry.kind === 'doc-pointer' && entry.pointerId === probePointerId,
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
