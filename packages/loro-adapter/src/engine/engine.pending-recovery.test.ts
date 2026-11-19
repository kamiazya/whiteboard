import { MARKDOWN_MAX_CHARS, documentEngine as wire } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { createCrdtEngine } from './engine.js'

/**
 * An update that arrived before the one it builds on stays parked in the
 * document. The engine rebuilds a document from its own record after a refusal,
 * so that record has to carry the parked update too — a snapshot does not.
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

function updateOf(result: wire.MutationResult): string {
  if (result.outcome !== 'applied' || result.localUpdate === undefined)
    throw new Error('the fixture write produced no update')
  return result.localUpdate
}

/** An unrelated update large enough to outweigh the engine's recovery floor. */
function bulkUpdate(): string {
  const doc = new LoroDoc()
  doc.setPeerId(9n)
  doc.getText('bulk').insert(0, 'x'.repeat(200_000))
  doc.commit()
  return Buffer.from(doc.export({ mode: 'update' })).toString('base64')
}

describe('recovering a document that holds a parked update', () => {
  it('keeps an update that arrived before its dependency through a compaction and a refused write', async () => {
    const author = createCrdtEngine()
    const authored = author.open({ peer: '1' })
    const first = updateOf(writeBody(author, authored.handle, 'a'))
    const second = updateOf(writeBody(author, authored.handle, 'ab'))

    const engine = createCrdtEngine()
    const { handle } = engine.open({ peer: '2' })
    const early = engine.import({ handle, bytes: second, judge: 'none' })
    expect(early).toMatchObject({ outcome: 'applied', pending: true })
    engine.import({ handle, bytes: bulkUpdate(), judge: 'none' })
    const refused = writeBody(engine, handle, 'y'.repeat(MARKDOWN_MAX_CHARS + 1))
    expect(refused.outcome).toBe('refused')

    engine.import({ handle, bytes: first, judge: 'none' })
    expect(await bodyOf(engine, handle)).toBe('ab')
  })
})
