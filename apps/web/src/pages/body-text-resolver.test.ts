/**
 * The container a mounted CRDT binding addresses must not move under it.
 *
 * `LoroSyncPlugin` maps the editor's offsets onto whatever the resolver it was
 * built with answers AT THE MOMENT OF EACH EDIT. A workspace document's body
 * lives on its tree node and a legacy one's on the doc's root, and those are
 * genuinely different containers — so a resolver that can change its mind
 * between two keystrokes points the second one at text the first never wrote.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  MARKDOWN_BODY_KEY,
} from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { bodyTextResolver } from './use-markdown-document.js'

const DOCUMENT_ID = generateDocumentId()
const BODY = 'a body only the tree node has'

function workspaceWithBody(): Loro {
  const workspace = new Loro()
  createWorkspaceDocumentAtPath(workspace, {
    path: 'note',
    documentId: DOCUMENT_ID,
    kind: 'markdown',
  })
  documentContainers(workspace, DOCUMENT_ID).getText(MARKDOWN_BODY_KEY).insert(0, BODY)
  workspace.commit()
  return workspace
}

describe('bodyTextResolver', () => {
  it('reads a workspace document from its tree node, not the doc root', () => {
    const workspace = workspaceWithBody()
    const resolve = bodyTextResolver({ mode: 'workspace' } as never, DOCUMENT_ID)

    expect(resolve(workspace).toString()).toBe(BODY)
  })

  it('answers a container the workspace root does not have', () => {
    // The two branches are not interchangeable, which is what makes swapping
    // between them catastrophic rather than merely wrong: the root container
    // of a workspace document is EMPTY, so offsets from the tree node address
    // nothing at all. Measured on CI as `Index out of bound. The given pos is
    // 1, but the length is 0`.
    const workspace = workspaceWithBody()
    const asLegacy = bodyTextResolver(null, DOCUMENT_ID)

    expect(asLegacy(workspace).toString()).toBe('')
    expect(asLegacy(workspace).length).toBe(0)
  })

  it('keeps answering the host it was built with after a later host exists', () => {
    // The regression itself. The load effect clears its host reference
    // synchronously on every re-run while the editor stays mounted; a resolver
    // that read that reference took the legacy branch for the whole of the
    // next load and answered the empty root. Holding the host as a parameter
    // is what makes that unavailable rather than merely discouraged.
    const workspace = workspaceWithBody()
    const resolve = bodyTextResolver({ mode: 'workspace' } as never, DOCUMENT_ID)
    const first = resolve(workspace).toString()

    // Whatever else the hook does to its own state afterwards, this closure
    // cannot see it — there is no reference here to reach.
    bodyTextResolver(null, DOCUMENT_ID)
    bodyTextResolver({ mode: 'legacy' } as never, DOCUMENT_ID)

    expect(resolve(workspace).toString()).toBe(first)
    expect(resolve(workspace).toString()).toBe(BODY)
  })
})
