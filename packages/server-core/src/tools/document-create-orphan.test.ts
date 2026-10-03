import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { wbDocumentCreate } from './document-crud.js'

const WS = 'orphan'

describe('a create that cannot finish leaves nothing behind', () => {
  it.each([
    ['.nan', 'NaN'],
    ['.inf', 'Infinity'],
  ])('refuses frontmatter holding %s by naming the key, and leaves the path free', async (yaml, shown) => {
    // Accepted on write, such a value fails every batch read that names the
    // document; the check that refuses it on the way out has to run on the way
    // in, before a document exists to hold the path.
    const deps = makeTestDeps({ documentStore: new InMemoryDocumentStore() })
    await deps.documentIndex.createWorkspace({ workspaceId: WS })

    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'weird',
        kind: 'markdown',
        markdown: `---\ntype: note\nweird: ${yaml}\n---\nbody`,
      }),
    ).rejects.toThrow(new RegExp(`weird: ${shown}.*yaml-safe`))

    expect(await deps.documentIndex.listDocuments({ workspaceId: WS })).toEqual([])
  })

  it('does not squat the path with an empty document when the body is malformed', async () => {
    // The body is written by delegating to `wb_document_set`, which runs
    // AFTER the document exists — so without a preflight the parse failure
    // left an empty document holding the path while the caller held an
    // error saying the create had not happened. The retry then collided
    // with the ghost.
    const deps = makeTestDeps({ documentStore: new InMemoryDocumentStore() })
    // The workspace exists up front, so this case is only about the DOCUMENT.
    // It used to arrive via `createWorkspace: true` and the comment claimed
    // the refusal left no workspace either — which was not true then (the
    // bootstrap ran before the preflight) and was asserted by nothing. It IS
    // true now, and `document-crud.mint.test.ts` is where it is checked.
    await deps.documentIndex.createWorkspace({ workspaceId: WS })

    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'taken-by-nothing',
        kind: 'markdown',
        markdown: '---\nthis: [is: not: yaml\n---\nbody',
      }),
    ).rejects.toThrow(/okf|frontmatter|yaml|parse/i)

    expect(
      (await deps.documentIndex.listDocuments({ workspaceId: WS })).map((d) => d.path),
    ).toEqual([])

    // And the path is still free, which is the thing a caller retries into.
    const retried = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'taken-by-nothing',
      kind: 'markdown',
      markdown: '---\ntype: note\n---\nvalid this time',
    })
    expect(retried.path).toBe('taken-by-nothing')
  })
})
