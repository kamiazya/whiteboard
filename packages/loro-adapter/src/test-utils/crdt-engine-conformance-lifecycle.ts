/**
 * The conformance cases for how a document is opened, read in place and put to
 * rest: a snapshot opened with the updates after it, a read that answers
 * without waiting, and a handle that gives its weight back while it stays open.
 */
import { MARKDOWN_MAX_CHARS, documentEngine as wire } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { CrdtEngine } from '../engine/types.js'
import {
  applied,
  ask,
  bodyOf,
  jsonOf,
  mutation,
  openWith,
  splice,
  write,
} from './crdt-engine-conformance-kit.js'

const TOO_LONG = { op: 'writeMarkdownBody', args: { body: 'y'.repeat(MARKDOWN_MAX_CHARS + 1) } }

const refusedWrite = (engine: CrdtEngine, handle: number) =>
  mutation(engine.write(wire.writeRequestSchema.parse({ handle, batch: [TOO_LONG] })))

export function describeReadNow(makeEngine: () => CrdtEngine) {
  describe('a read that answers without waiting', () => {
    it('answers every query but the file scan as the asynchronous read does', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'hello')
      const names = wire.queryNameSchema.options.filter((name) => name !== 'fileReferences')
      expect(names.length).toBeGreaterThan(20)
      for (const query of names) {
        const now = engine.readNow(wire.readRequestSchema.parse({ handle, query: { query } }))
        expect(jsonOf(now.value), query).toEqual(await ask(engine, handle, query))
      }
    })

    it('refuses the file scan, which asks the keeper and so cannot answer in place', () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'hello')
      expect(() => engine.readNow({ handle, query: { query: 'fileReferences' } })).toThrow(
        /fileReferences/,
      )
    })

    it('refuses a handle that is not open', () => {
      expect(() => makeEngine().readNow({ handle: 99, query: { query: 'markdownBody' } })).toThrow(
        /not open/,
      )
    })
  })
}

export function describeOpenWithUpdates(makeEngine: () => CrdtEngine) {
  describe('opening a snapshot with the updates after it', () => {
    function source() {
      const origin = makeEngine()
      const handle = openWith(origin, 'one', '5')
      const snapshot = origin.export({ handle, mode: 'snapshot' }).bytes
      const updates = [
        splice(origin, handle, 3, 0, ' two').localUpdate as string,
        splice(origin, handle, 7, 0, ' three').localUpdate as string,
      ]
      return { snapshot, updates }
    }

    it('holds the document the snapshot and the updates make, with no undo step for them', async () => {
      const { snapshot, updates } = source()
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '9', bytes: snapshot, updates })
      expect(await bodyOf(engine, handle)).toBe('one two three')
      expect(engine.undoState({ handle })).toEqual({ canUndo: false, canRedo: false })
    })

    it('opens from the updates alone', async () => {
      const { updates } = source()
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '9', updates })
      // The first update builds on operations the document lacks, so none show yet.
      expect(await bodyOf(engine, handle)).toBe('')
    })

    it('restores to the opened document, updates included, when a write is refused', async () => {
      const { snapshot, updates } = source()
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '9', bytes: snapshot, updates })
      expect(refusedWrite(engine, handle).outcome).toBe('refused')
      expect(await bodyOf(engine, handle)).toBe('one two three')
      applied(
        engine.write(
          wire.writeRequestSchema.parse({
            handle,
            batch: [{ op: 'writeMarkdownBody', args: { body: 'after' } }],
          }),
        ),
      )
      expect(await bodyOf(engine, handle)).toBe('after')
    })
  })
}

export function describeTrim(makeEngine: () => CrdtEngine) {
  describe('trimming an idle handle', () => {
    it('leaves every read as it was', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'hello')
      splice(engine, handle, 5, 0, ' world')
      const before = await ask(engine, handle, 'markdownBody')
      const version = engine.version({ handle })
      engine.trim({ handle })
      expect(await ask(engine, handle, 'markdownBody')).toEqual(before)
      expect(engine.version({ handle })).toEqual(version)
    })

    it('still judges a write and refuses it, restoring the document', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'kept')
      write(engine, handle, 'writeMarkdownBody', { body: 'kept too' })
      engine.trim({ handle })
      expect(refusedWrite(engine, handle)).toMatchObject({
        outcome: 'refused',
        breach: { shape: 'run' },
      })
      expect(await bodyOf(engine, handle)).toBe('kept too')
      write(engine, handle, 'writeMarkdownBody', { body: 'then this' })
      expect(await bodyOf(engine, handle)).toBe('then this')
    })

    it('keeps the undo history, which is not what it frees', async () => {
      const engine = makeEngine()
      const handle = engine.open({ peer: '1', undoMergeIntervalMs: 0 }).handle
      splice(engine, handle, 0, 0, 'a')
      engine.trim({ handle })
      expect(engine.undoState({ handle })).toEqual({ canUndo: true, canRedo: false })
      engine.undo({ handle })
      expect(await bodyOf(engine, handle)).toBe('')
    })

    it('refuses a handle that is not open', () => {
      expect(() => makeEngine().trim({ handle: 4 })).toThrow(/not open/)
    })
  })
}
