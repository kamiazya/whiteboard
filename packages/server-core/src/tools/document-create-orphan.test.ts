import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { ignoredDocumentWrites } from '../test-utils/ignored-document-writes.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { wbDocumentCreate } from './document-crud.js'

const WS = 'orphan'

describe('a create that cannot finish leaves nothing behind', () => {
  it('does not squat the path with an empty document when the body is malformed', async () => {
    // The body is written by delegating to `wb_document_set`, which runs
    // AFTER the document exists — so without a preflight the parse failure
    // left an empty document holding the path while the caller held an
    // error saying the create had not happened. The retry then collided
    // with the ghost.
    const deps = {
      documentStore: createInMemoryDocumentStore(),
      blobStore: {} as never,
      documentTeardown: unusedDocumentTeardown(),
      documentWritten: ignoredDocumentWrites(),
      documentIndex: new InMemoryDocumentIndex(),
    }
    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'taken-by-nothing',
        kind: 'markdown',
        createWorkspace: true,
        markdown: '---\nthis: [is: not: yaml\n---\nbody',
      }),
    ).rejects.toThrow(/okf|frontmatter|yaml|parse/i)

    expect(
      (await deps.documentIndex.listDocuments({ workspaceId: WS })).map((d) => d.path),
    ).toEqual([])

    // And the path is still free, which is the thing a caller retries into.
    // `createWorkspace` is needed again: refusing before any write means the
    // workspace was not created either, which is the point.
    const retried = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'taken-by-nothing',
      kind: 'markdown',
      createWorkspace: true,
      markdown: '---\ntype: note\n---\nvalid this time',
    })
    expect(retried.path).toBe('taken-by-nothing')
  })
})
