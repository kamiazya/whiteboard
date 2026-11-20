import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { RecordBytesRejectedError } from '../record-kind.js'
import { createWorkspaceDocumentAtPath } from '../workspace-tree.js'
import { openStandalone } from './standalone.js'

const NOTE = '01BRWAAAAAAAAAAAAAAAAAAAA0'

function snapshot(): Uint8Array {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'note', documentId: NOTE, kind: 'markdown' })
  doc.commit()
  return new Uint8Array(doc.export({ mode: 'snapshot' }))
}

describe('a record opened from bytes', () => {
  it('answers the reads of the record the bytes describe, and gives itself back once', async () => {
    const { session, release } = await openStandalone(snapshot())
    const documents = await session.read(
      { query: 'documents' },
      { parse: (value) => value as Array<{ documentId: string }> },
    )
    expect(documents.map((entry) => entry.documentId)).toEqual([NOTE])
    release()
    expect(() => release()).not.toThrow()
    // Given back: the engine holds no record for it any more.
    await expect(
      session.read({ query: 'documents' }, { parse: (value) => value }),
    ).rejects.toBeDefined()
  })

  it('refuses bytes that are not a document as RecordBytesRejectedError', async () => {
    await expect(openStandalone(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(
      RecordBytesRejectedError,
    )
  })
})
