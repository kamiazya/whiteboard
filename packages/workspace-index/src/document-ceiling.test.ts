/**
 * A workspace holds at most 2000 documents, and every way this index places a
 * NEW one — create, duplicate, restore from the trash — refuses past it. Both
 * keepers place through this class, so the ceiling the sync path holds is
 * held here as well.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import {
  INDEX_SUBJECTS,
  indexOver,
  inMemoryBlobStore,
  liveWorkspaceDocs,
} from './test-utils/index-subjects.js'

/** Written out rather than imported, so the test is not judged by the constant it judges. */
const CEILING = 2000
const WS = '01VVDXVXXBD837WHWMG6YE6X15'

describe.each(INDEX_SUBJECTS)('a workspace at its document ceiling over $name', (subject) => {
  let docs: ReturnType<typeof liveWorkspaceDocs>
  let index: LoroWorkspaceDocumentIndex<unknown>

  beforeEach(async () => {
    docs = liveWorkspaceDocs(subject)
    index = indexOver(subject, docs, inMemoryBlobStore())
    await index.createWorkspace({ workspaceId: WS })
  })

  const held = async () => (await subject.kind.documents(docs.peek(WS))).length

  it('still creates the document that reaches the ceiling', async () => {
    await subject.fillDocuments(docs.peek(WS), CEILING - 1)
    await index.createDocument({ workspaceId: WS, path: 'last', kind: 'markdown' })
    expect(await held()).toBe(CEILING)
  })

  it('refuses to create one more', async () => {
    await subject.fillDocuments(docs.peek(WS), CEILING)
    await expect(
      index.createDocument({ workspaceId: WS, path: 'one-more', kind: 'markdown' }),
    ).rejects.toMatchObject({ code: 'too_many_documents', status: 413 })
    expect(await held()).toBe(CEILING)
  })

  it('refuses to duplicate one', async () => {
    await index.createDocument({ workspaceId: WS, path: 'source', kind: 'markdown' })
    await subject.fillDocuments(docs.peek(WS), CEILING)
    await expect(
      index.duplicateDocument({ workspaceId: WS, path: 'source' }),
    ).rejects.toMatchObject({ code: 'too_many_documents', status: 413 })
    expect(await held()).toBe(CEILING)
  })

  it('refuses to restore one from the trash, and keeps the trash row', async () => {
    const { documentId } = await index.createDocument({
      workspaceId: WS,
      path: 'victim',
      kind: 'markdown',
    })
    await index.deleteDocument({ workspaceId: WS, path: 'victim' })
    await subject.fillDocuments(docs.peek(WS), CEILING)
    await expect(index.restoreDocument({ workspaceId: WS, documentId })).rejects.toMatchObject({
      code: 'too_many_documents',
      status: 413,
    })
    expect(await held()).toBe(CEILING)
    expect((await subject.kind.trash(docs.peek(WS))).map((row) => row.documentId)).toEqual([
      documentId,
    ])
  })
})
