import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc, type LoroText } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
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
    ).toEqual({ shape: 'body', chars: MARKDOWN_MAX_CHARS + 1 })
    expect(
      syncTextLimitBreach(
        base,
        updateFrom(base, DOC_ID, (body) => body.delete(0, 1)),
      ),
    ).toBe(null)

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
    ).toBe(null)
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

  fcTest.prop(
    [
      fc.integer({ min: MARKDOWN_MAX_CHARS - 2_000, max: MARKDOWN_MAX_CHARS + 2_000 }),
      fc.integer({ min: 0, max: 3_000 }),
      fc.integer({ min: 0, max: 3_000 }),
    ],
    withDefaults({ numRuns: 25 }),
  )('answers as the full judgement does, near the limit', (before, deleted, inserted) => {
    const base = record({ [DOC_ID]: 'y'.repeat(before) })
    const update = updateFrom(base, DOC_ID, (body) => {
      body.delete(0, Math.min(deleted, body.length))
      body.insert(0, 'z'.repeat(inserted))
    })
    const full = importWithinTextLimits(base.fork(), update).breach
    expect(syncTextLimitBreach(base, update)).toEqual(full)
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
