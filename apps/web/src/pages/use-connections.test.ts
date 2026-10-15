import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ConnectionsBacklink } from '../components/connections/ConnectionsPanel.js'
import { type Connections, connectionsStamp, useConnections } from './use-connections.js'

const OPEN = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

const list = (openAt: string, otherAt: string, otherPath = 'plan') => [
  { documentId: OPEN, path: 'main', name: 'Main', updatedAt: openAt },
  { documentId: OTHER, path: otherPath, name: 'Plan', updatedAt: otherAt },
]

const row = (documentId: string, path: string, name: string) => ({
  documentId,
  path,
  name,
  updatedAt: '1',
})

describe('connectionsStamp', () => {
  it('stays put when only the open document is edited', () => {
    expect(connectionsStamp(list('1', '1'), OPEN)).toBe(connectionsStamp(list('2', '1'), OPEN))
  })

  it('moves when another document is edited or moved', () => {
    const before = connectionsStamp(list('1', '1'), OPEN)
    expect(connectionsStamp(list('1', '2'), OPEN)).not.toBe(before)
    expect(connectionsStamp(list('1', '1', 'notes/plan'), OPEN)).not.toBe(before)
  })

  // Mentions are found by name and each row shows its source's name, so a
  // rename made elsewhere has to re-ask even though no clock in view moved.
  describe('moves on a rename or move the list carries', () => {
    const before = connectionsStamp([row(OPEN, 'main', 'Main'), row(OTHER, 'plan', 'Plan')], OPEN)

    it('another document is renamed', () => {
      const after = [row(OPEN, 'main', 'Main'), row(OTHER, 'plan', 'Roadmap')]
      expect(connectionsStamp(after, OPEN)).not.toBe(before)
    })

    it('the open document is renamed', () => {
      const after = [row(OPEN, 'main', 'Home'), row(OTHER, 'plan', 'Plan')]
      expect(connectionsStamp(after, OPEN)).not.toBe(before)
    })

    it('the open document is moved', () => {
      const after = [row(OPEN, 'notes/main', 'Main'), row(OTHER, 'plan', 'Plan')]
      expect(connectionsStamp(after, OPEN)).not.toBe(before)
    })
  })
})

const backlinks = (count: number): Connections => ({
  backlinks: Array.from(
    { length: count },
    (_, i): ConnectionsBacklink => ({
      documentId: `${OTHER}${i}`,
      path: `p${i}`,
      name: `N${i}`,
      contexts: [],
    }),
  ),
  unlinkedMentions: [],
})

describe('useConnections', () => {
  it('keeps the newer answer when an older read lands after it', async () => {
    const pending: { promise: Promise<Connections>; resolve: (c: Connections) => void }[] = []
    const read = (_documentId: string) => {
      const next = Promise.withResolvers<Connections>()
      pending.push(next)
      return next.promise
    }
    const { result, rerender } = renderHook(
      ({ stamp }: { stamp: string }) =>
        useConnections({ read, documentId: OPEN, path: 'main', stamp }),
      { initialProps: { stamp: 's1' } },
    )
    await waitFor(() => expect(pending).toHaveLength(1))
    rerender({ stamp: 's2' })
    await waitFor(() => expect(pending).toHaveLength(2))

    await act(async () => {
      pending[1]?.resolve(backlinks(2))
      await pending[1]?.promise
    })
    await waitFor(() => expect(result.current.connections?.backlinks).toHaveLength(2))

    // Awaiting the stale promise inside act runs the hook's own `.then`
    // first (it was attached earlier), so any state it sets is flushed here.
    await act(async () => {
      pending[0]?.resolve(backlinks(0))
      await pending[0]?.promise
    })
    expect(result.current.connections?.backlinks).toHaveLength(2)
  })
})
