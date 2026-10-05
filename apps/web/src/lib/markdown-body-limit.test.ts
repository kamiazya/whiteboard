import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { overfilledBody } from './markdown-body-limit.js'

const DOC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function record(body: string): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'notes', documentId: DOC_ID, kind: 'markdown' })
  writeMarkdownBody(documentContainers(doc, DOC_ID), body)
  return doc
}

function edit(base: LoroDoc, change: (body: ReturnType<LoroDoc['getText']>) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  change(documentContainers(client, DOC_ID).getText('body'))
  client.commit()
  return client.export({ mode: 'update', from })
}

describe('overfilledBody', () => {
  it('answers the length a body would grow to past the limit, and leaves the record untouched', () => {
    const base = record('y'.repeat(MARKDOWN_MAX_CHARS - 1))
    const version = base.oplogVersion()
    const update = edit(base, (body) => body.insert(0, 'ab'))

    expect(overfilledBody(base, DOC_ID, update)).toBe(MARKDOWN_MAX_CHARS + 1)
    expect(base.oplogVersion().compare(version)).toBe(0)
  })

  it('answers null for an edit that stays within the limit', () => {
    const base = record('y'.repeat(MARKDOWN_MAX_CHARS - 2))
    expect(
      overfilledBody(
        base,
        DOC_ID,
        edit(base, (body) => body.insert(0, 'ab')),
      ),
    ).toBeNull()
  })

  it('answers null for an edit that shrinks a body already past the limit', () => {
    const base = record('y'.repeat(MARKDOWN_MAX_CHARS + 4))
    expect(
      overfilledBody(
        base,
        DOC_ID,
        edit(base, (body) => body.delete(0, 2)),
      ),
    ).toBeNull()
  })

  it('refuses one insert past the limit without applying it', () => {
    const base = record('short')
    const update = edit(base, (body) => body.insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS)))
    expect(overfilledBody(base, DOC_ID, update)).toBeGreaterThan(MARKDOWN_MAX_CHARS)
  })
})
