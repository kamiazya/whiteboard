import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentGetTool } from './document-get.js'

const WS = 'create-body'

function makeDeps() {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
  }
}

const MARKDOWN = '---\ntype: note\ntags:\n  - alpha\n---\nThe body, written at creation time.'

describe('creating a markdown document with its body', () => {
  it('needs one call, not two', async () => {
    const deps = makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'untitled-1',
      kind: 'markdown',
      name: 'note',
      createWorkspace: true,
      markdown: MARKDOWN,
    })
    const read = await createDocumentGetTool(deps).execute({
      workspaceId: WS,
      documentId: created.documentId,
    })
    expect(read.content).toContain('The body, written at creation time.')
    expect(read.content).toContain('alpha')
  })

  it('still creates an empty document when no body is given', async () => {
    const deps = makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'untitled-2',
      kind: 'markdown',
      createWorkspace: true,
    })
    expect(created.documentId).toBeTruthy()
    expect(created.path).toBe('untitled-2')
  })

  it('refuses a body on a spatial document rather than dropping it', async () => {
    // A spatial document's content is JSON Canvas, edited through
    // `wb_canvas_edit`. Accepting markdown here and ignoring it would lose
    // a caller's content silently; the type says no, and so does the parse.
    const deps = makeDeps()
    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'untitled-3',
        kind: 'spatial',
        createWorkspace: true,
        markdown: MARKDOWN,
      } as never),
    ).rejects.toThrow()
  })
})
