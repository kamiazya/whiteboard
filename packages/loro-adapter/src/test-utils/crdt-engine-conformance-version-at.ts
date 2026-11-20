/**
 * The conformance cases for asking a document which operations it held at a
 * past point: the answer is the one the document gave when it stood there, so a
 * keeper that kept only a point's frontiers can order and cut its history
 * without holding a copy of the document at that point.
 */
import type { documentEngine as wire } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { CrdtEngine } from '../engine/types.js'
import { openWith, splice } from './crdt-engine-conformance-kit.js'

export function describeVersionAt(makeEngine: () => CrdtEngine) {
  describe('what a document held at a past point', () => {
    it('answers what the document answered when it stood there', () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'one', '7')
      const then = engine.version({ handle })
      splice(engine, handle, 3, 0, ' two')
      splice(engine, handle, 7, 0, ' three')
      expect(engine.version({ handle })).not.toEqual(then)
      expect(engine.version({ handle, at: then.frontiers })).toEqual(then)
    })

    it('answers for a point that merged two peers, as the document did at the merge', () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'base', '7')
      const other = makeEngine()
      const there = other.open({
        peer: '5',
        bytes: engine.export({ handle, mode: 'snapshot' }).bytes,
      })
      const theirs = splice(other, there.handle, 4, 0, ' theirs').localUpdate as string
      splice(engine, handle, 0, 0, 'mine ')
      engine.import({ handle, bytes: theirs })
      const merged = engine.version({ handle })
      expect(merged.frontiers.length, 'the merge has two heads').toBe(2)
      splice(engine, handle, 0, 0, 'later ')
      expect(engine.version({ handle, at: merged.frontiers })).toEqual(merged)
    })

    it('answers for a point a peer alone had reached, though the document holds more', () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'base', '7')
      const other = makeEngine()
      const there = other.open({
        peer: '5',
        bytes: engine.export({ handle, mode: 'snapshot' }).bytes,
      })
      const theirs = splice(other, there.handle, 4, 0, ' theirs')
      const alone = other.version({ handle: there.handle })
      splice(engine, handle, 0, 0, 'mine ')
      engine.import({ handle, bytes: theirs.localUpdate as string })
      expect(engine.version({ handle, at: alone.frontiers })).toEqual(alone)
    })

    it('answers the frontiers a point reaches, however the caller spelled it', () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'one', '7')
      const first = engine.version({ handle })
      splice(engine, handle, 3, 0, ' two')
      const second = engine.version({ handle })
      // Naming an operation the next one built on adds nothing: the point is the later one.
      const spelled = [...(first.frontiers as wire.VersionEntry[]), ...second.frontiers]
      expect(engine.version({ handle, at: spelled })).toEqual(second)
    })

    it('answers the start as no operation held', () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'one', '7')
      expect(engine.version({ handle, at: [] })).toMatchObject({ version: [], frontiers: [] })
    })

    it('refuses a point the document does not hold', () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'one', '7')
      const head = engine.version({ handle })
      expect(() => engine.version({ handle, at: [{ peer: '424242', counter: 7 }] })).toThrow()
      const [only] = head.frontiers
      expect(() =>
        engine.version({
          handle,
          at: [{ peer: only?.peer ?? '', counter: (only?.counter ?? 0) + 1 }],
        }),
      ).toThrow()
    })
  })
}
