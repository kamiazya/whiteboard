import {
  readMarkdownBody,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { Loro } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { browserBacklinksReader } from './browser-backlinks.js'
import { linkifyBrowserMentions } from './browser-linkify.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { ensureLocalWorkspace } from './local-document-summary.js'
import { LoroStore } from './loro-store.js'
import { loadDocumentContent, seedWorkspaceDocumentContent } from './workspace-content.js'

// The browser keeper's **Link**, over real IndexedDB and the production index:
// the source is a node of this browser's workspace record, edited in place.

claimIsolatedWhiteboardDb('browser-linkify')

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

describe("the browser keeper's Link on a mention", () => {
  it('writes the mention as a link in the source, and the source becomes a backlink', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    const beta = await note(index, 'beta', 'Beta', 'The target.')
    const gamma = await note(index, 'gamma', 'Gamma', 'Beta came up in the review.')
    const read = browserBacklinksReader(index, new LoroStore())
    expect((await read(beta)).unlinkedMentions.map((entry) => entry.path)).toEqual(['gamma'])

    expect(await linkifyBrowserMentions(index, gamma, beta)).toBe(1)

    const source = await loadDocumentContent(gamma)
    expect(source === null ? null : readMarkdownBody(source)).toBe(
      '[[beta|Beta]] came up in the review.',
    )
    // Through the SAME reader: the source's digest moved, so its facts are
    // read again and the row changes sides.
    const after = await read(beta)
    expect(after.backlinks.map((entry) => entry.path)).toEqual(['gamma'])
    expect(after.unlinkedMentions).toEqual([])
  })

  it('writes nothing when the source has nothing to link', async () => {
    const index = new FoldingBrowserIndex()
    await ensureLocalWorkspace(index)
    const beta = await note(index, 'beta', 'Beta', 'The target.')
    const alpha = await note(index, 'alpha', 'Alpha', 'Nothing about it here.')

    expect(await linkifyBrowserMentions(index, alpha, beta)).toBe(0)
    const source = await loadDocumentContent(alpha)
    expect(source === null ? null : readMarkdownBody(source)).toBe('Nothing about it here.')
  })
})
