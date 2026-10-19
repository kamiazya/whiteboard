import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { importWithinTextLimits } from './sync-text-limits.js'

function seeded(): LoroDoc {
  const doc = new LoroDoc()
  doc.setPeerId(1n)
  doc.getText('body').insert(0, 's')
  doc.commit()
  return doc
}

function editOf(base: LoroDoc, edit: (client: LoroDoc) => void): Uint8Array {
  const client = base.fork()
  client.setPeerId(2n)
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

/**
 * The engine applies each run in time quadratic in its length, so what
 * attaching an update costs is the sum of its runs' squared lengths — not its
 * longest run. An update of many runs each just under the limit would
 * otherwise be applied whole, paying for every one of them, before any bound
 * after the attach could refuse it.
 */
describe('the run budget prices every run an update carries', () => {
  it('refuses runs each under the limit that together cost more than one at it, unapplied', () => {
    const doc = seeded()
    const piece = (MARKDOWN_MAX_CHARS * 3) / 4
    const update = editOf(doc, (client) => {
      client.getText('a').insert(0, 'a'.repeat(piece))
      client.getText('b').insert(0, 'b'.repeat(piece))
    })
    const total = 2 * piece
    expect(total).toBe(393_216)
    const attach = vi.spyOn(doc, 'attach')

    const { breach } = importWithinTextLimits(doc, update)

    // Every unit the update inserts reaches the state on attach, or none does.
    const unitsApplied = attach.mock.calls.length > 0 ? total : 0
    expect(unitsApplied).toBe(0)
    expect(breach).toMatchObject({ shape: 'runs', chars: total, runs: 2 })
  })

  it('prices scattered runs in one text the same way', () => {
    const doc = seeded()
    const piece = (MARKDOWN_MAX_CHARS * 3) / 4
    const update = editOf(doc, (client) => {
      const text = client.getText('a')
      text.insert(0, 'a'.repeat(piece))
      // Before the last one, so the two never join into one run.
      text.insert(0, 'b'.repeat(piece))
    })
    const attach = vi.spyOn(doc, 'attach')

    expect(importWithinTextLimits(doc, update).breach).toMatchObject({
      shape: 'runs',
      chars: 2 * piece,
    })
    expect(attach).not.toHaveBeenCalled()
  })

  it('keeps the single-run refusal for one run past the limit', () => {
    const doc = seeded()
    const update = editOf(doc, (client) => {
      client.getText('a').insert(0, 'a'.repeat(MARKDOWN_MAX_CHARS + 1))
      client.getText('b').insert(0, 'b'.repeat(MARKDOWN_MAX_CHARS / 2))
    })
    expect(importWithinTextLimits(doc, update).breach).toMatchObject({
      shape: 'run',
      chars: MARKDOWN_MAX_CHARS + 1,
    })
  })

  it('takes one run at the limit, the cost the budget is sized to', () => {
    const doc = seeded()
    const update = editOf(doc, (client) => {
      client.getText('a').insert(0, 'a'.repeat(MARKDOWN_MAX_CHARS))
    })
    expect(importWithinTextLimits(doc, update).breach).toBeNull()
  })

  it('takes many small inserts that together are far past the limit, as an editor sends', () => {
    // Runs no longer than 4 Ki units can only exceed the budget past 16 Mi
    // units in total, which is more than a request body may carry.
    const doc = seeded()
    const piece = 'x'.repeat(4096)
    const pieces = 160
    const update = editOf(doc, (client) => {
      for (let i = 0; i < pieces; i += 1) {
        const text = client.getText(i % 2 === 0 ? 'a' : 'b')
        text.insert(0, piece)
      }
    })
    expect(pieces * piece.length).toBeGreaterThan(2 * MARKDOWN_MAX_CHARS)

    expect(importWithinTextLimits(doc, update).breach).toBeNull()
    expect(doc.getText('a').length + doc.getText('b').length).toBe(pieces * piece.length)
  })
})
