/**
 * The conformance cases for a record's shallow root: where its kept history
 * starts, as a version answers it, and a shallow snapshot cut at a version
 * vector. A keeper that chooses its own cut (by what its stored points had
 * seen, never by an engine's policy) asks the engine for these facts and
 * keeps the choosing.
 */
import { documentEngine as wire } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { frontierPairs } from '../engine/answers.js'
import type { CrdtEngine } from '../engine/types.js'
import { held, openWith, splice } from './crdt-engine-conformance-kit.js'

const entriesOf = (pairs: Array<[string, number]>) =>
  pairs.map(([peer, counter]) => ({ peer, counter }))

/** A document of three edits by one peer, and the version after each. */
function threeEdits(makeEngine: () => CrdtEngine) {
  const engine = makeEngine()
  const handle = openWith(engine, 'one', '7')
  const first = engine.version({ handle })
  splice(engine, handle, 3, 0, ' two')
  const second = engine.version({ handle })
  splice(engine, handle, 7, 0, ' three')
  return { engine, handle, first, second, third: engine.version({ handle }) }
}

export function describeShallowRoot(makeEngine: () => CrdtEngine) {
  describe('where a document keeps its history from', () => {
    it('answers no root for a document that keeps every operation', () => {
      const { engine, handle, second } = threeEdits(makeEngine)
      expect(engine.version({ handle }).shallowRoot).toEqual([])
      expect(engine.version({ handle, at: second.frontiers }).shallowRoot).toEqual([])
    })

    it('answers the frontiers a shallow snapshot was cut at, for a document opened from one', () => {
      const { engine, handle, second } = threeEdits(makeEngine)
      const { bytes } = engine.export({
        handle,
        mode: 'shallow-snapshot',
        frontiers: second.frontiers,
      })
      const other = makeEngine()
      const opened = other.open({ peer: '2', bytes })
      const answer = wire.versionResponseSchema.parse(other.version({ handle: opened.handle }))
      expect(answer.shallowRoot).toEqual(second.frontiers)
      // What npm loro says the opened document's root is, not what the engine says of its own.
      expect(
        entriesOf(frontierPairs(held(other, opened.handle, 'snapshot').shallowSinceFrontiers())),
      ).toEqual(answer.shallowRoot)
      expect(other.version({ handle: opened.handle, at: answer.frontiers }).shallowRoot).toEqual(
        second.frontiers,
      )
    })

    it('cuts a shallow snapshot at a version vector as at the frontiers that vector reaches', () => {
      const { engine, handle, second, third } = threeEdits(makeEngine)
      const cut = engine.export({
        handle,
        mode: 'shallow-snapshot-at-version',
        version: second.version,
      })
      const other = makeEngine()
      const opened = other.open({ peer: '2', bytes: cut.bytes })
      const answer = other.version({ handle: opened.handle })
      expect(answer.shallowRoot).toEqual(second.frontiers)
      expect(answer.version).toEqual(third.version)
      // The history from the cut on is kept, so the cut point itself still checks out.
      expect(() =>
        other.fork({ handle: opened.handle, peer: '3', at: second.frontiers }),
      ).not.toThrow()
    })

    it('keeps no history before the version it is cut at', () => {
      const { engine, handle, first, second } = threeEdits(makeEngine)
      const cut = engine.export({
        handle,
        mode: 'shallow-snapshot-at-version',
        version: second.version,
      })
      const other = makeEngine()
      const opened = other.open({ peer: '2', bytes: cut.bytes })
      expect(() => other.fork({ handle: opened.handle, peer: '3', at: first.frontiers })).toThrow()
    })

    it('refuses a cut at a version the document does not hold', () => {
      const { engine, handle } = threeEdits(makeEngine)
      expect(() =>
        engine.export({
          handle,
          mode: 'shallow-snapshot-at-version',
          version: [{ peer: '424242', counter: 7 }],
        }),
      ).toThrow()
    })
  })
}
