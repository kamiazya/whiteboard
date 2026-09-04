import {
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { IdbDocumentIndex } from './idb-document-index.js'
import { ensureLocalWorkspace } from './local-document-summary.js'
import { createLocalFilesSource } from './local-files-source.js'
import { LoroStore } from './loro-store.js'
import { seedWorkspaceDocumentContent } from './workspace-content.js'

// Body search in local mode, against real IndexedDB: the browser ranks with
// the same stage-0 core the daemon uses, so a query finds the same
// documents in either mode.

claimIsolatedWhiteboardDb('local-body-search')

async function seedMarkdown(index: IdbDocumentIndex, path: string, body: string): Promise<string> {
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path,
    kind: 'markdown',
  })
  const doc = new Loro()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, body)
  await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))
  return entry.documentId
}

async function seedSpatial(index: IdbDocumentIndex, path: string, canvas: SpatialCanvas) {
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path,
    kind: 'spatial',
  })
  const doc = new Loro()
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, canvas)
  await new LoroStore().save(entry.documentId, doc.export({ mode: 'snapshot' }))
}

describe('local body search', () => {
  it('finds a document by a word that appears only in its body', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await seedMarkdown(index, 'notes/one', 'The quota exceeded error shows up on save.')
    await seedMarkdown(index, 'notes/two', 'Nothing relevant here at all.')
    const source = createLocalFilesSource()

    const hits = await source.searchDocuments('quota')
    expect(hits.map((h) => h.document.path)).toEqual(['notes/one'])
    // The excerpt says WHY the row is here.
    expect(hits[0]?.contexts.join(' ')).toContain('quota')
  })

  it('searches a canvas through its node and edge labels', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await seedSpatial(index, 'diagrams/auth', {
      nodes: [
        { id: 'n1', type: 'text', text: 'Session handshake', x: 0, y: 0, width: 80, height: 40 },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n1', label: 'retries' }],
    })
    const source = createLocalFilesSource()

    expect((await source.searchDocuments('handshake')).map((h) => h.document.path)).toEqual([
      'diagrams/auth',
    ])
    expect((await source.searchDocuments('retries')).map((h) => h.document.path)).toEqual([
      'diagrams/auth',
    ])
  })

  it('finds a Japanese name by its first character', async () => {
    // What a Japanese reader types first is one character. Bigram-only
    // indexing answered nothing for it, and the panel had already shown the
    // document from its name — so the row appeared and then vanished.
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const id = await seedMarkdown(index, 'notes/kana', 'ひらがなだけの本文です。')
    await index.setDocumentName({
      workspaceId: getBrowserWorkspaceId(),
      documentId: id,
      name: 'たささたはな',
    })
    await seedMarkdown(index, 'notes/other', 'Nothing relevant here at all.')
    const source = createLocalFilesSource()

    expect((await source.searchDocuments('た')).map((h) => h.document.path)).toEqual(['notes/kana'])
    // The control: the widening is a match, not a list of everything.
    expect(await source.searchDocuments('ぬ')).toEqual([])
  })

  it('answers nothing for an empty query', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await seedMarkdown(index, 'solo', 'anything')
    expect(await createLocalFilesSource().searchDocuments('   ')).toEqual([])
  })

  it('sees an edit without being told, and re-reads only what changed', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    const id = await seedMarkdown(index, 'draft', 'first wording')
    const source = createLocalFilesSource()
    expect(await source.searchDocuments('rewritten')).toEqual([])

    // Edit through the store the app writes to: the first search above
    // folded this document into the workspace tree, so the edit goes to the
    // tree node — a raw LoroStore save would be invisible behind the
    // tree projection, which is the point of the collapse, not a bug.
    const doc = new Loro()
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, 'rewritten wording')
    expect(await seedWorkspaceDocumentContent(id, doc.export({ mode: 'snapshot' }))).toBe(true)

    expect((await source.searchDocuments('rewritten')).map((h) => h.document.path)).toEqual([
      'draft',
    ])
  })

  it('finds a renamed document under its new path, not its old one', async () => {
    // The corpus caches on the CONTENT stamp, and a rename does not move it.
    // Caching the path alongside the text would leave the search matching a
    // name the workspace no longer uses.
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await seedMarkdown(index, 'drafts/first', 'A body with no distinctive words.')
    const source = createLocalFilesSource({ index })

    expect((await source.searchDocuments('first', 20)).length).toBe(1)
    await source.renameDocumentPath('drafts/first', 'drafts/renamed')

    expect((await source.searchDocuments('renamed', 20))[0]?.document.path).toBe('drafts/renamed')
    expect(await source.searchDocuments('first', 20)).toEqual([])
  })

  it('ranks its own hits 1-based, so a caller can tell a keyword hit from none', async () => {
    // Local mode has no embedder, so every hit here IS a lexical hit — the
    // rank is what says so, and its absence is what a semantic-only hit
    // from the daemon would carry.
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await seedMarkdown(index, 'ranked/heavy', 'zarquon zarquon zarquon exceeded on save')
    await seedMarkdown(index, 'ranked/light', 'a passing mention of zarquon')
    const source = createLocalFilesSource({ index })

    const hits = await source.searchDocuments('zarquon', 20)
    expect(hits.map((hit) => hit.document.path)).toEqual(['ranked/heavy', 'ranked/light'])
    expect(hits.map((hit) => hit.lexicalRank)).toEqual([1, 2])
  })
})
