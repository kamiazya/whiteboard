/**
 * The browser keeper's half of reference-following: a move through the
 * browser files source repoints references other documents wrote to the old
 * path — the same codec plan the daemon's route applies, so both modes give
 * one answer.
 *
 * Seeded into, and read back from, the workspace record through the
 * production index and the one content read: a rewrite saved anywhere else
 * (the retired per-document store) is a rewrite no reader sees.
 */

import {
  readMarkdownBody,
  readSpatialCanvas,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { nodeFile, nodeText } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { Loro, type LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedWorkspaceDocumentContent } from '../test-utils/seed-workspace-content.js'
import { ensureBrowserWorkspace } from './browser-document-summary.js'
import { createBrowserFilesSource } from './browser-files-source.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { LoroStore } from './loro-store.js'
import { loadDocumentContent } from './workspace-content.js'

claimIsolatedWhiteboardDb('browser-follow-rename')

// The claim is made once per MODULE, and `--repeats` re-runs the tests
// without re-importing — so without this every seed after the first collides
// on its own path (`DocumentPathTakenError`). The same beat as
// `browser-search.browser.test.tsx`, and found the same way: CI's
// `stress-changed-tests` repeats a PR's touched test files in-process, so a
// file that was never repeat-safe becomes a candidate the moment a diff
// touches it.
beforeEach(async () => {
  await clearWhiteboardDb()
})

async function seedContent(documentId: string, doc: LoroDoc): Promise<void> {
  expect(await seedWorkspaceDocumentContent(documentId, doc.export({ mode: 'snapshot' }))).toBe(
    true,
  )
}

async function seedMarkdown(
  index: FoldingBrowserIndex,
  path: string,
  body: string,
  name?: string,
): Promise<string> {
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path,
    kind: 'markdown',
    ...(name === undefined ? {} : { name }),
  })
  const doc = new Loro()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, body)
  await seedContent(entry.documentId, doc)
  return entry.documentId
}

async function seedSpatial(index: FoldingBrowserIndex, path: string, canvas: SpatialCanvas) {
  const entry = await index.createDocument({
    workspaceId: getBrowserWorkspaceId(),
    path,
    kind: 'spatial',
  })
  const doc = new Loro()
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, canvas)
  await seedContent(entry.documentId, doc)
  return entry.documentId
}

async function contentOf(documentId: string): Promise<LoroDoc> {
  const doc = await loadDocumentContent(documentId)
  if (doc === null) throw new Error(`no content: ${documentId}`)
  return doc
}

async function bodyOf(documentId: string): Promise<string> {
  return readMarkdownBody(await contentOf(documentId))
}

describe('browser rename follows references', () => {
  it('a path move repoints markdown and spatial references to the old path', async () => {
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    await seedMarkdown(index, 'follow/design-login', 'the target')
    const sourceId = await seedMarkdown(
      index,
      'follow/daily',
      'see [[follow/design-login]] and [[unrelated]]',
    )
    const boardId = await seedSpatial(index, 'follow/board', {
      nodes: [
        textNode({
          id: 't1',
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          text: 'see [[follow/design-login]]',
        }),
        fileNode({ id: 'f1', x: 0, y: 60, width: 100, height: 40, file: 'follow/design-login' }),
      ],
      edges: [],
    })

    const source = createBrowserFilesSource({ index })
    await source.renameDocumentPath('follow/design-login', 'follow/archive-login')

    expect(await bodyOf(sourceId)).toBe('see [[follow/archive-login]] and [[unrelated]]')
    const canvas = readSpatialCanvas(await contentOf(boardId))
    const movedText = canvas.nodes.find((n) => n.id === 't1')
    expect(movedText !== undefined && nodeText(movedText)).toBe('see [[follow/archive-login]]')
    const movedFile = canvas.nodes.find((n) => n.id === 'f1')
    expect(movedFile !== undefined && nodeFile(movedFile)).toBe('follow/archive-login')
  })

  it('a subtree move follows references to a descendant', async () => {
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    await seedMarkdown(index, 'tree/folder', 'the parent')
    await seedMarkdown(index, 'tree/folder/child', 'the child')
    const sourceId = await seedMarkdown(index, 'tree/daily', 'see [[tree/folder/child]]')

    const source = createBrowserFilesSource({ index })
    await source.renameDocumentPath('tree/folder', 'tree/archive')

    expect(await bodyOf(sourceId)).toBe('see [[tree/archive/child]]')
  })

  it('writes the repointed reference into the record, never the per-document store', async () => {
    const index = new FoldingBrowserIndex()
    await ensureBrowserWorkspace(index)
    await seedMarkdown(index, 'legacy/target', 'the target')
    const sourceId = await seedMarkdown(index, 'legacy/daily', 'see [[legacy/target]]')

    await createBrowserFilesSource({ index }).renameDocumentPath('legacy/target', 'legacy/moved')

    expect((await new LoroStore().load(sourceId)).kind).toBe('not-found')
  })
})
