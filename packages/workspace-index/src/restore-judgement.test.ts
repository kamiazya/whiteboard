/**
 * A trash row names one document; the bytes it points at must be rooted at
 * that document. A document that merely sits somewhere inside them is not the
 * row's document, and restoring them would bring back its ancestor instead.
 */
import {
  createWorkspaceDocumentAtPath,
  exportWorkspaceSubtree,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { restorableTrashDocuments } from './restore-judgement.js'

const ROOT = '01BRWAAAAAAAAAAAAAAAAAAAA0'
const CHILD = '01BRWAAAAAAAAAAAAAAAAAAAA1'

/** A subtree rooted at `ROOT` holding `CHILD` beneath it. */
function rootWithDescendant(): Uint8Array {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'top', documentId: ROOT, kind: 'markdown' })
  createWorkspaceDocumentAtPath(doc, { path: 'top/inner', documentId: CHILD, kind: 'markdown' })
  return exportWorkspaceSubtree(doc, 'top') as Uint8Array
}

describe('judging bytes against the document a trash row is for', () => {
  it('accepts bytes rooted at the row document and counts its descendants', async () => {
    expect(
      await restorableTrashDocuments(rootWithDescendant(), {
        documentId: ROOT,
        parentPath: undefined,
      }),
    ).toEqual({ documents: 2, folders: 0 })
  })

  it('refuses bytes rooted at another document that merely hold the row document', async () => {
    expect(
      await restorableTrashDocuments(rootWithDescendant(), {
        documentId: CHILD,
        parentPath: undefined,
      }),
    ).toBeNull()
  })
})
