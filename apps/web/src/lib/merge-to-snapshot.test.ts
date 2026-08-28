import { Loro } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { mergeToSnapshot } from './merge-to-snapshot.js'

describe('mergeToSnapshot', () => {
  it('imports a snapshot and deltas into one combined snapshot', () => {
    const base = new Loro()
    base.getMovableList('elements').push('a')
    base.commit()
    const snapshot = base.export({ mode: 'snapshot' })
    const prevVV = base.version()

    base.getMovableList('elements').push('b')
    base.commit()
    const delta = base.export({ mode: 'update', from: prevVV })

    const merged = mergeToSnapshot(snapshot, [delta])

    const reimported = new Loro()
    reimported.import(merged)
    expect(reimported.getMovableList('elements').toJSON()).toEqual(['a', 'b'])
  })

  it('returns the snapshot unchanged (re-importable) when there are no deltas', () => {
    const base = new Loro()
    base.getMovableList('elements').push('solo')
    base.commit()
    const snapshot = base.export({ mode: 'snapshot' })

    const merged = mergeToSnapshot(snapshot, [])
    const reimported = new Loro()
    reimported.import(merged)
    expect(reimported.getMovableList('elements').toJSON()).toEqual(['solo'])
  })
})
