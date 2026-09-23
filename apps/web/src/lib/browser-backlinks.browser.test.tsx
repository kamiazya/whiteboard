import { writeDocumentKind, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { Loro } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { browserBacklinksReader } from './browser-backlinks.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { ensureLocalWorkspace } from './local-document-summary.js'
import { LoroStore } from './loro-store.js'
import { seedWorkspaceDocumentContent } from './workspace-content.js'

// The browser keeper answering "what links here" from its own documents,
// over real IndexedDB and the production tree-backed index — so every listing
// carries the content digest the cache keys on, as it does for a user.

claimIsolatedWhiteboardDb('browser-backlinks')

beforeEach(async () => {
  await clearWhiteboardDb()
})

function markdown(body: string): Uint8Array {
  const doc = new Loro()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, body)
  return doc.export({ mode: 'snapshot' })
}

async function note(index: FoldingBrowserIndex, path: string, name: string, body: string) {
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path,
    kind: 'markdown',
    name,
  })
  expect(await seedWorkspaceDocumentContent(entry.documentId, markdown(body))).toBe(true)
  return entry.documentId
}

describe('the browser keeper answering what links here', () => {
  it('lists a document that links here, and one that names it without a link', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    const beta = await note(index, 'beta', 'Beta', 'The target.')
    await note(index, 'alpha', 'Alpha', 'See [[beta]] for the details.')
    await note(index, 'gamma', 'Gamma', 'Beta came up in the review.')
    const read = browserBacklinksReader(index, new LoroStore())

    const answer = await read(beta)

    expect(answer.backlinks.map((entry) => entry.path)).toEqual(['alpha'])
    expect(answer.unlinkedMentions.map((entry) => entry.path)).toEqual(['gamma'])
  })

  // The reader keeps its facts between asks. What that must never cost is a
  // stale answer: an edit that drops the link has to drop the backlink on
  // the very next ask, through the same reader.
  it('drops a backlink on the next ask once the link is edited away', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    const beta = await note(index, 'beta', 'Beta', 'The target.')
    const alpha = await note(index, 'alpha', 'Alpha', 'See [[beta]] for the details.')
    const read = browserBacklinksReader(index, new LoroStore())
    expect((await read(beta)).backlinks.map((entry) => entry.path)).toEqual(['alpha'])

    await seedWorkspaceDocumentContent(alpha, markdown('No link any more.'))

    expect((await read(beta)).backlinks).toEqual([])
  })
})
