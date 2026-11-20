import { LoroDoc, type VersionVector } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { opsSince } from './ops-since.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

/** What an export of the range holds of each operation, which is all a span must agree on. */
function exportedOps(doc: LoroDoc, since: VersionVector) {
  const head = doc.oplogVersion()
  const { changes } = doc.exportJsonUpdates(since, head, false)
  head.free()
  return changes.flatMap((change) => change.ops.map((op) => [op.counter, op.container, op.content]))
}

const keyOf = (value: unknown) => JSON.stringify(value)

describe('opsSince', () => {
  // Each step is one peer writing one key on a copy of the record and the
  // record taking its update, so the record holds spans of several peers.
  fcTest.prop(
    [
      fc.array(fc.record({ peer: fc.integer({ min: 1, max: 4 }), key: fc.string() }), {
        minLength: 1,
        maxLength: 12,
      }),
      fc.nat(),
    ],
    withDefaults({ numRuns: 80 }),
  )('holds the operations an export of the same range holds', (steps, cut) => {
    const record = new LoroDoc()
    record.setPeerId(100)
    const versions: VersionVector[] = [record.oplogVersion()]
    for (const { peer, key } of steps) {
      const replica = new LoroDoc()
      replica.setPeerId(peer)
      replica.import(record.export({ mode: 'snapshot' }))
      replica.getMap('m').set(key, peer)
      replica.getList('l').push(key)
      replica.commit()
      record.import(replica.export({ mode: 'update' }))
      versions.push(record.oplogVersion())
    }
    const since = versions[cut % versions.length] as VersionVector

    const held = opsSince(record, since).map((op) => [op.counter, op.container, op.content])
    expect(held.map(keyOf).sort()).toEqual(exportedOps(record, since).map(keyOf).sort())
  })

  fcTest('holds nothing for the version the record is at', () => {
    const record = new LoroDoc()
    record.getMap('m').set('k', 1)
    record.commit()
    expect(opsSince(record, record.oplogVersion())).toEqual([])
  })
})
