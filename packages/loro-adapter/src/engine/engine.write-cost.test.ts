import { MARKDOWN_MAX_CHARS, documentEngine as wire } from '@kamiazya/whiteboard-model'
import { LoroDoc, UndoManager } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCrdtEngine } from './engine.js'

/**
 * What a write costs the engine, held where the root cause is: a write judges
 * its update on a copy the engine keeps, and a refusal rebuilds the document
 * from bytes it already holds. Neither replays the document's history, which
 * costs seconds once one large insert is in it.
 */
const writeBody = (engine: ReturnType<typeof createCrdtEngine>, handle: number, body: string) =>
  engine.write(
    wire.writeRequestSchema.parse({
      handle,
      batch: [{ op: 'writeMarkdownBody', args: { body } }],
    }),
  )

const bodyOf = async (engine: ReturnType<typeof createCrdtEngine>, handle: number) => {
  const { value } = await engine.read({ handle, query: { query: 'markdownBody' } })
  return (value as { ok: string }).ok
}

describe('what a write costs the engine', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('judges every write on one kept copy, never on a fork of the document per write', () => {
    const engine = createCrdtEngine()
    const { handle } = engine.open({ peer: '1' })
    writeBody(engine, handle, 'warm')
    const fork = vi.spyOn(LoroDoc.prototype, 'fork')
    const forkAt = vi.spyOn(LoroDoc.prototype, 'forkAt')
    for (let i = 0; i < 20; i++) writeBody(engine, handle, `edit ${i}`)
    expect(fork).not.toHaveBeenCalled()
    expect(forkAt).not.toHaveBeenCalled()
  })

  it('judges a write the host has not asked to judge on no copy at all', () => {
    const engine = createCrdtEngine()
    const { handle } = engine.open({ peer: '1' })
    const fork = vi.spyOn(LoroDoc.prototype, 'fork')
    const forkAt = vi.spyOn(LoroDoc.prototype, 'forkAt')
    const batch = (body: string) => [{ op: 'writeMarkdownBody', args: { body } }]
    for (let i = 0; i < 5; i++) {
      engine.write(wire.writeRequestSchema.parse({ handle, batch: batch(`${i}`), judge: 'none' }))
    }
    engine.textSplice({
      handle,
      text: 'body',
      runs: [{ index: 0, remove: 0, insert: 'a' }],
      judge: 'none',
    })
    engine.undo({ handle, judge: 'none' })
    engine.redo({ handle, judge: 'none' })
    expect(fork).not.toHaveBeenCalled()
    expect(forkAt).not.toHaveBeenCalled()
    // The document and its undo history are all the handle holds: no judging copy was made.
    const docs = vi.spyOn(LoroDoc.prototype, 'free')
    engine.close({ handle })
    expect(docs).toHaveBeenCalledTimes(1)
  })

  it('refuses a write past a limit without replaying the history behind it', async () => {
    const engine = createCrdtEngine()
    const { handle } = engine.open({ peer: '1' })
    // One long insert in the history: the case where rebuilding a version by replay is slow.
    writeBody(engine, handle, 'x'.repeat(MARKDOWN_MAX_CHARS - 1))
    writeBody(engine, handle, 'kept')
    const forkAt = vi.spyOn(LoroDoc.prototype, 'forkAt')
    const refused = writeBody(engine, handle, 'y'.repeat(MARKDOWN_MAX_CHARS + 1))
    expect(refused).toMatchObject({ outcome: 'refused', breach: { shape: 'run' } })
    expect(forkAt).not.toHaveBeenCalled()
    expect(await bodyOf(engine, handle)).toBe('kept')
    writeBody(engine, handle, 'still works')
    expect(await bodyOf(engine, handle)).toBe('still works')
  })

  it('restores the document an import and many writes built, folding what it keeps into a snapshot', async () => {
    const engine = createCrdtEngine()
    const { handle } = engine.open({ peer: '1' })
    // Past the point where the engine stops keeping every update and takes a snapshot.
    for (let i = 0; i < 12; i++) writeBody(engine, handle, `${i}`.repeat(10_000))
    const last = await bodyOf(engine, handle)
    const refused = writeBody(engine, handle, 'z'.repeat(MARKDOWN_MAX_CHARS + 1))
    expect(refused.outcome).toBe('refused')
    expect(await bodyOf(engine, handle)).toBe(last)
  })

  it('restores a document opened from bytes, and a document a thrown writer interrupted', async () => {
    const source = createCrdtEngine()
    const from = source.open({ peer: '1' })
    writeBody(source, from.handle, 'opened')
    const engine = createCrdtEngine()
    const { handle } = engine.open({
      peer: '2',
      bytes: source.export({ handle: from.handle, mode: 'snapshot' }).bytes,
    })
    writeBody(engine, handle, 'then written')
    const batch = [
      { op: 'writeMarkdownBody', args: { body: 'lost' } },
      { op: 'createWorkspaceDocument', args: { segment: 'no id' } },
    ]
    expect(() => engine.write(wire.writeRequestSchema.parse({ handle, batch }))).toThrow()
    expect(await bodyOf(engine, handle)).toBe('then written')
    writeBody(engine, handle, 'and after')
    expect(await bodyOf(engine, handle)).toBe('and after')
  })

  it('opens a snapshot with a long log of updates without exporting a snapshot of it', async () => {
    const origin = createCrdtEngine()
    const from = origin.open({ peer: '1' })
    const snapshot = origin.export({ handle: from.handle, mode: 'snapshot' }).bytes
    // Together past the point where keeping each update would fold the log into a snapshot.
    const updates = Array.from({ length: 12 }, (_, i) => {
      const result = writeBody(origin, from.handle, `${i}`.repeat(10_000))
      return (result as { localUpdate: string }).localUpdate
    })
    const exported = vi.spyOn(LoroDoc.prototype, 'export')
    const engine = createCrdtEngine()
    const { handle } = engine.open({ peer: '2', bytes: snapshot, updates })
    expect(exported).not.toHaveBeenCalled()
    expect(await bodyOf(engine, handle)).toBe('11'.repeat(10_000))
  })
})

describe('what a handle holds while it is open', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('frees the document, the copy its writes are judged on and the undo history on close', () => {
    const engine = createCrdtEngine()
    const { handle } = engine.open({ peer: '1' })
    writeBody(engine, handle, 'judged on a copy')
    const docs = vi.spyOn(LoroDoc.prototype, 'free')
    const undos = vi.spyOn(UndoManager.prototype, 'free')
    engine.close({ handle })
    expect(docs).toHaveBeenCalledTimes(2)
    // Two documents, not one freed twice.
    expect(new Set(docs.mock.contexts).size).toBe(2)
    expect(undos).toHaveBeenCalledTimes(1)
  })

  it('folds the recovery log into one snapshot on trim, and exports nothing when there is none', () => {
    const engine = createCrdtEngine()
    const { handle } = engine.open({ peer: '1' })
    const exported = vi.spyOn(LoroDoc.prototype, 'export')
    engine.trim({ handle })
    expect(exported).not.toHaveBeenCalled()
    writeBody(engine, handle, 'one')
    exported.mockClear()
    engine.trim({ handle })
    expect(exported).toHaveBeenCalledTimes(1)
    expect(exported).toHaveBeenCalledWith({ mode: 'snapshot' })
    engine.trim({ handle })
    expect(exported).toHaveBeenCalledTimes(1)
  })

  it('frees the copy on trim, and judges the next write on a new one', async () => {
    const engine = createCrdtEngine()
    const { handle } = engine.open({ peer: '1' })
    writeBody(engine, handle, 'judged on a copy')
    const docs = vi.spyOn(LoroDoc.prototype, 'free')
    engine.trim({ handle })
    expect(docs).toHaveBeenCalledTimes(1)
    writeBody(engine, handle, 'and on a new one')
    expect(await bodyOf(engine, handle)).toBe('and on a new one')
  })

  it('frees the document a refused write rebuilt, not only the one a close ends', () => {
    const engine = createCrdtEngine()
    const { handle } = engine.open({ peer: '1' })
    writeBody(engine, handle, 'kept')
    const docs = vi.spyOn(LoroDoc.prototype, 'free')
    const refused = writeBody(engine, handle, 'y'.repeat(MARKDOWN_MAX_CHARS + 1))
    expect(refused.outcome).toBe('refused')
    // The document before the rebuild and the copy the judge spent.
    expect(docs).toHaveBeenCalledTimes(2)
    expect(new Set(docs.mock.contexts).size).toBe(2)
  })
})
