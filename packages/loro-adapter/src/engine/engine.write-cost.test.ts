import { MARKDOWN_MAX_CHARS, documentEngine as wire } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
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
})
