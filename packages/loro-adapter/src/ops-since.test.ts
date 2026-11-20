import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { type Frontiers, LoroDoc, type VersionVector } from 'loro-crdt'
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

const EQUIVALENCE = 'holds the operations an export of the same range holds'
// Measured over 12 runs of the property's 80 cases: 60 to 68 non-empty ranges,
// and 20 to 34 that start before a compacted record's kept history.
const NON_EMPTY_FLOOR = 40
const BEFORE_KEPT_HISTORY_FLOOR = 10
const reached = { nonEmpty: 0, beforeKeptHistory: 0 }

/** Whether `since` names operations the compacted `record` no longer holds. */
function startsBeforeKeptHistory(record: LoroDoc, since: VersionVector): boolean {
  const kept = record.shallowSinceVV()
  const held = since.toJSON()
  const before = [...kept.toJSON()].some(([peer, counter]) => (held.get(peer) ?? 0) < counter)
  kept.free()
  return before
}

describe('opsSince', () => {
  afterAllFloor([EQUIVALENCE], () => {
    expect(reached.nonEmpty).toBeGreaterThanOrEqual(NON_EMPTY_FLOOR)
    expect(reached.beforeKeptHistory).toBeGreaterThanOrEqual(BEFORE_KEPT_HISTORY_FLOOR)
  })

  // Each step is one peer writing one key on a copy of the record and the
  // record taking its update, so the record holds spans of several peers.
  // `compactAt`, when drawn, reopens the record from a shallow snapshot cut at
  // one of its versions: a range may then start before the history it kept.
  fcTest.prop(
    [
      fc.array(fc.record({ peer: fc.integer({ min: 1, max: 4 }), key: fc.string() }), {
        minLength: 1,
        maxLength: 12,
      }),
      fc.nat(),
      fc.option(fc.nat(), { nil: undefined }),
    ],
    withDefaults({ numRuns: 80 }),
  )(EQUIVALENCE, (steps, cut, compactAt) => {
    let record = new LoroDoc()
    record.setPeerId(100)
    const versions: VersionVector[] = [record.oplogVersion()]
    const frontiers: Frontiers[] = []
    for (const { peer, key } of steps) {
      const replica = new LoroDoc()
      replica.setPeerId(peer)
      replica.import(record.export({ mode: 'snapshot' }))
      replica.getMap('m').set(key, peer)
      replica.getList('l').push(key)
      replica.commit()
      record.import(replica.export({ mode: 'update' }))
      versions.push(record.oplogVersion())
      frontiers.push(record.frontiers())
    }
    if (compactAt !== undefined) {
      const kept = frontiers[compactAt % frontiers.length] as Frontiers
      const compacted = new LoroDoc()
      compacted.import(record.export({ mode: 'shallow-snapshot', frontiers: kept }))
      record = compacted
    }
    const since = versions[cut % versions.length] as VersionVector

    const held = opsSince(record, since).map((op) => [op.counter, op.container, op.content])
    const exported = exportedOps(record, since)
    expect(held.map(keyOf).sort()).toEqual(exported.map(keyOf).sort())
    if (exported.length > 0) reached.nonEmpty += 1
    if (exported.length > 0 && startsBeforeKeptHistory(record, since))
      reached.beforeKeptHistory += 1
  })

  fcTest('holds nothing for the version the record is at', () => {
    const record = new LoroDoc()
    record.getMap('m').set('k', 1)
    record.commit()
    expect(opsSince(record, record.oplogVersion())).toEqual([])
  })
})
