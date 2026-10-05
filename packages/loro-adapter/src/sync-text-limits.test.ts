import { MARKDOWN_MAX_CHARS, NODE_TEXT_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroText } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeSpatialNode } from './loro-bridge.js'
import { importWithinTextLimits, syncTextLimitBreach } from './sync-text-limits.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const OTHER_ID = '01BRWAAAAAAAAAAAAAAAAAAAA6'

function record(bodies: Readonly<Record<string, string>>): LoroDoc {
  const doc = new LoroDoc()
  for (const [documentId, body] of Object.entries(bodies)) {
    createWorkspaceDocumentAtPath(doc, {
      path: `d${documentId.at(-1)}`,
      documentId,
      kind: 'markdown',
    })
    documentContainers(doc, documentId).getText('body').insert(0, body)
  }
  doc.commit()
  return doc
}

function updateFrom(base: LoroDoc, documentId: string, edit: (body: LoroText) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(documentContainers(client, documentId).getText('body'))
  client.commit()
  return client.export({ mode: 'update', from })
}

describe('syncTextLimitBreach', () => {
  it('leaves the record as it was, whatever the verdict', () => {
    const base = record({ [DOC_ID]: 'y'.repeat(MARKDOWN_MAX_CHARS - 1) })
    const version = base.oplogVersion()
    const snapshotBytes = base.export({ mode: 'snapshot' }).byteLength

    expect(
      syncTextLimitBreach(
        base,
        updateFrom(base, DOC_ID, (body) => body.insert(0, 'ab')),
      ),
    ).toMatchObject({ shape: 'body', chars: MARKDOWN_MAX_CHARS + 1 })
    expect(
      syncTextLimitBreach(
        base,
        updateFrom(base, DOC_ID, (body) => body.delete(0, 1)),
      ),
    ).toBeNull()

    expect(base.oplogVersion().compare(version)).toBe(0)
    // Reading a body length must not open a root the record never had.
    expect(base.export({ mode: 'snapshot' }).byteLength).toBe(snapshotBytes)
  })

  it('judges a short update against a body it does not touch only by what it does', () => {
    // The short-update answer is bounded by the LONGEST body in the record, so
    // a long body elsewhere sends the update to the full judgement rather
    // than refusing it.
    const base = record({ [DOC_ID]: 'short', [OTHER_ID]: 'y'.repeat(MARKDOWN_MAX_CHARS) })
    expect(
      syncTextLimitBreach(
        base,
        updateFrom(base, DOC_ID, (body) => body.insert(0, 'ab')),
      ),
    ).toBeNull()
  })

  it("refuses a node's text past the node limit however short every body is", () => {
    const base = record({ [DOC_ID]: 'short' })
    const client = base.fork()
    const from = client.oplogVersion()
    writeSpatialNode(documentContainers(client, DOC_ID), {
      id: 'n1',
      resource: { mimeType: 'text/markdown', content: 'x'.repeat(NODE_TEXT_MAX_CHARS + 1) },
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    })
    client.commit()

    expect(syncTextLimitBreach(base, client.export({ mode: 'update', from }))).toEqual({
      shape: 'node-text',
      chars: NODE_TEXT_MAX_CHARS + 1,
      nodeId: 'n1',
    })
  })

  it('takes an update whose bytes are at least as many as every string it writes', () => {
    // The answer it gives without applying an update rests on this: a
    // compressing encoding would let a long, repetitive insert through.
    const base = record({ [DOC_ID]: 'seed' })
    for (const text of ['x'.repeat(50_000), '\u{1F600}'.repeat(10_000), 'é'.repeat(20_000)]) {
      const update = updateFrom(base, DOC_ID, (body) => body.insert(0, text))
      expect(update.byteLength).toBeGreaterThanOrEqual(text.length)
    }
    const client = base.fork()
    const from = client.oplogVersion()
    client.getMap('m').set('value', 'z'.repeat(50_000))
    client.commit()
    expect(client.export({ mode: 'update', from }).byteLength).toBeGreaterThanOrEqual(50_000)
  })

  const edit = fc.record({
    at: fc.double({ min: 0, max: 1, noNaN: true }),
    deleted: fc.integer({ min: 0, max: 3_000 }),
    inserted: fc.integer({ min: 0, max: 3_000 }),
  })

  fcTest.prop(
    [
      fc.integer({ min: MARKDOWN_MAX_CHARS - 4_000, max: MARKDOWN_MAX_CHARS + 2_000 }),
      fc.array(edit, { minLength: 1, maxLength: 4 }),
    ],
    withDefaults({ numRuns: 25 }),
  )('refuses exactly the edits that leave a body past the limit and longer', (before, edits) => {
    const base = record({ [DOC_ID]: 'y'.repeat(before) })
    const update = updateFrom(base, DOC_ID, (body) => {
      for (const { at, deleted, inserted } of edits) {
        const pos = Math.floor(at * body.length)
        body.delete(pos, Math.min(deleted, body.length - pos))
        body.insert(pos, 'z'.repeat(inserted))
      }
    })
    // The oracle applies the update plainly and measures the body, so it
    // shares nothing with how the judgement reads the update's operations.
    const applied = base.fork()
    applied.import(update)
    const after = documentContainers(applied, DOC_ID).getText('body').length
    const expected =
      after > MARKDOWN_MAX_CHARS && after > before
        ? { shape: 'body', chars: after, container: expect.any(String) }
        : null

    expect(importWithinTextLimits(base.fork(), update).breach).toEqual(expected)
    expect(syncTextLimitBreach(base, update)).toEqual(expected)
  })
})

describe('importWithinTextLimits', () => {
  it('rethrows bytes the engine refuses and leaves the document usable', () => {
    const doc = record({ [DOC_ID]: 'kept' })
    expect(() => importWithinTextLimits(doc, new Uint8Array([1, 2, 3, 4]))).toThrow()
    documentContainers(doc, DOC_ID).getText('body').insert(0, 'still ')
    expect(documentContainers(doc, DOC_ID).getText('body').toString()).toBe('still kept')
  })

  it('answers whether the update touched a workspace node meta', () => {
    const base = record({ [DOC_ID]: 'body' })
    const bodyEdit = updateFrom(base, DOC_ID, (body) => body.insert(0, 'more '))
    expect(importWithinTextLimits(base.fork(), bodyEdit).touchesNodeMeta).toBe(false)

    const client = base.fork()
    const from = client.oplogVersion()
    createWorkspaceDocumentAtPath(client, { path: 'other', documentId: OTHER_ID, kind: 'markdown' })
    client.commit()
    const created = client.export({ mode: 'update', from })
    expect(importWithinTextLimits(base.fork(), created).touchesNodeMeta).toBe(true)
  })
})

/** A standalone document's body, as the per-document sync route carries it. */
describe('importWithinTextLimits on update shapes', () => {
  function seeded(body: string): LoroDoc {
    const doc = new LoroDoc()
    doc.setPeerId(1n)
    doc.getText('body').insert(0, body)
    doc.commit()
    return doc
  }

  function editOf(base: LoroDoc, edit: (doc: LoroDoc, body: LoroText) => void): Uint8Array {
    const client = base.fork()
    client.setPeerId(2n)
    const from = client.oplogVersion()
    edit(client, client.getText('body'))
    client.commit()
    return client.export({ mode: 'update', from })
  }

  it('refuses a replacement that grows a body past the limit', () => {
    const doc = seeded('y'.repeat(MARKDOWN_MAX_CHARS - 1))
    const update = editOf(doc, (_, body) => {
      body.delete(0, 3)
      body.insert(0, 'abcde')
    })
    expect(importWithinTextLimits(doc, update).breach).toEqual({
      shape: 'body',
      chars: MARKDOWN_MAX_CHARS + 1,
      container: doc.getText('body').id,
    })
  })

  it('takes a replacement that shrinks a body already past the limit', () => {
    const doc = seeded('y'.repeat(MARKDOWN_MAX_CHARS + 10))
    const update = editOf(doc, (_, body) => {
      body.delete(0, 10)
      body.insert(0, 'abcde')
    })
    expect(importWithinTextLimits(doc, update).breach).toBeNull()
    expect(doc.getText('body')).toHaveLength(MARKDOWN_MAX_CHARS + 5)
  })

  it('takes an equal-length replacement in a body already past the limit', () => {
    const doc = seeded('y'.repeat(MARKDOWN_MAX_CHARS + 10))
    const update = editOf(doc, (_, body) => {
      body.delete(0, 5)
      body.insert(0, 'abcde')
    })
    expect(importWithinTextLimits(doc, update).breach).toBeNull()
    expect(doc.getText('body').toString().startsWith('abcde')).toBe(true)
  })

  it('reads two inserts at scattered positions as two runs, so the body arm refuses', () => {
    const half = Math.floor(MARKDOWN_MAX_CHARS / 2) + 10
    const doc = seeded('short')
    const update = editOf(doc, (_, body) => {
      body.insert(0, 'a'.repeat(half))
      body.insert(0, 'b'.repeat(half))
    })
    expect(importWithinTextLimits(doc, update).breach).toMatchObject({ shape: 'body' })
  })

  it('reads a positional continuation after another op as a new run', () => {
    const half = Math.floor(MARKDOWN_MAX_CHARS / 2) + 10
    // Seeded, because into an empty document no run is judged at all.
    const doc = seeded('s')
    const update = editOf(doc, (client, body) => {
      body.insert(1, 'a'.repeat(half))
      client.getMap('m').set('k', 1)
      body.insert(1 + half, 'b'.repeat(half))
    })
    expect(importWithinTextLimits(doc, update).breach).toMatchObject({ shape: 'body' })
  })

  it('leaves the document attached after bytes the engine refuses', () => {
    const doc = seeded('short')
    expect(() => importWithinTextLimits(doc, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow()
    expect(doc.isDetached()).toBe(false)
  })
})

describe('importWithinTextLimits into an empty document', () => {
  /** A record whose history once held one insert past the limit, since cut back. */
  function shrunkAfterLongPaste(): LoroDoc {
    const doc = record({ [DOC_ID]: 'intro\n' })
    const body = documentContainers(doc, DOC_ID).getText('body')
    body.insert(body.length, 'z'.repeat(MARKDOWN_MAX_CHARS + 10))
    doc.commit()
    body.delete(6, MARKDOWN_MAX_CHARS + 10)
    doc.commit()
    return doc
  }

  it('takes a record whose history held a run past the limit, since cut back', () => {
    const empty = new LoroDoc()
    const judged = importWithinTextLimits(
      empty,
      shrunkAfterLongPaste().export({ mode: 'snapshot' }),
    )
    expect(judged.breach).toBeNull()
    expect(empty.isDetached()).toBe(false)
    expect(documentContainers(empty, DOC_ID).getText('body').toString()).toBe('intro\n')
  })

  it('refuses the same record into a document that already holds something', () => {
    const held = record({ [OTHER_ID]: 'already here' })
    expect(
      importWithinTextLimits(held, shrunkAfterLongPaste().export({ mode: 'snapshot' })).breach,
    ).toMatchObject({ shape: 'run' })
  })

  it('still refuses a body or a node text the record holds past its limit', () => {
    const long = record({ [DOC_ID]: 'y'.repeat(MARKDOWN_MAX_CHARS + 1) })
    expect(
      importWithinTextLimits(new LoroDoc(), long.export({ mode: 'snapshot' })).breach,
    ).toMatchObject({ shape: 'body', chars: MARKDOWN_MAX_CHARS + 1 })

    const board = new LoroDoc()
    writeSpatialNode(board, {
      id: 'n1',
      resource: { mimeType: 'text/markdown', content: 'x'.repeat(NODE_TEXT_MAX_CHARS + 1) },
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    })
    expect(
      importWithinTextLimits(new LoroDoc(), board.export({ mode: 'snapshot' })).breach,
    ).toMatchObject({ shape: 'node-text', nodeId: 'n1' })
  })
})
