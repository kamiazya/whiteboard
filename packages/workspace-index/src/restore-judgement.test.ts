/**
 * A trash row names one document; the bytes it points at must be rooted at
 * that document. A document that merely sits somewhere inside them is not the
 * row's document, and restoring them would bring back its ancestor instead.
 */
import { describe, expect, it } from 'vitest'
import { restorableTrashDocuments } from './restore-judgement.js'
import { INDEX_SUBJECTS, type IndexSubject } from './test-utils/index-subjects.js'

const ROOT = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const CHILD = '01BRWAAAAAAAAAAAAAAAAAAAA1'

/** A subtree rooted at `ROOT` holding `CHILD` beneath it. */
async function rootWithDescendant(subject: IndexSubject): Promise<Uint8Array> {
  const record = await subject.kind.empty()
  subject.kind.write(record, [
    {
      op: 'createWorkspaceDocumentAtPath',
      args: { path: 'top', documentId: ROOT, kind: 'markdown' },
    },
    {
      op: 'createWorkspaceDocumentAtPath',
      args: { path: 'top/inner', documentId: CHILD, kind: 'markdown' },
    },
  ])
  return subject.kind.exportSubtree(record, 'top') as Uint8Array
}

describe.each(
  INDEX_SUBJECTS,
)('judging bytes against the document a trash row is for, over $name', (subject) => {
  it('accepts bytes rooted at the row document and counts its descendants', async () => {
    expect(
      await restorableTrashDocuments(await rootWithDescendant(subject), {
        documentId: ROOT,
        parentPath: undefined,
      }),
    ).toEqual({ documents: 2, folders: 0 })
  })

  it('refuses bytes rooted at another document that merely hold the row document', async () => {
    expect(
      await restorableTrashDocuments(await rootWithDescendant(subject), {
        documentId: CHILD,
        parentPath: undefined,
      }),
    ).toBeNull()
  })
})
