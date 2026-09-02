/**
 * The browser keeper's half of reference-following: a move through the
 * local files source repoints references other documents wrote to the old
 * path — the same codec plan the daemon's route applies, so both modes give
 * one answer.
 */
import {
  readMarkdownBody,
  readSpatialCanvas,
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

claimIsolatedWhiteboardDb('local-follow-rename')

async function seedMarkdown(
  index: IdbDocumentIndex,
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
  return entry.documentId
}

async function bodyOf(documentId: string): Promise<string> {
  const loaded = await new LoroStore().load(documentId)
  if (loaded.kind !== 'ok') throw new Error(`unreadable: ${loaded.kind}`)
  const doc = new Loro()
  doc.import(loaded.snapshot)
  for (const delta of loaded.deltas ?? []) doc.import(delta)
  return readMarkdownBody(doc)
}

describe('local rename follows references', () => {
  it('a path move repoints markdown and spatial references to the old path', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await seedMarkdown(index, 'follow/design-login', 'the target')
    const sourceId = await seedMarkdown(
      index,
      'follow/daily',
      'see [[follow/design-login]] and [[unrelated]]',
    )
    const boardId = await seedSpatial(index, 'follow/board', {
      nodes: [
        {
          id: 't1',
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          type: 'text',
          text: 'see [[follow/design-login]]',
        },
        {
          id: 'f1',
          x: 0,
          y: 60,
          width: 100,
          height: 40,
          type: 'file',
          file: 'follow/design-login',
        },
      ],
      edges: [],
    })

    const source = createLocalFilesSource({ index })
    await source.renameDocumentPath('follow/design-login', 'follow/archive-login')

    expect(await bodyOf(sourceId)).toBe('see [[follow/archive-login]] and [[unrelated]]')
    const loaded = await new LoroStore().load(boardId)
    if (loaded.kind !== 'ok') throw new Error('board unreadable')
    const doc = new Loro()
    doc.import(loaded.snapshot)
    const canvas = readSpatialCanvas(doc)
    expect(canvas.nodes.find((n) => n.id === 't1')).toMatchObject({
      text: 'see [[follow/archive-login]]',
    })
    expect(canvas.nodes.find((n) => n.id === 'f1')).toMatchObject({
      file: 'follow/archive-login',
    })
  })

  it('a subtree move follows references to a descendant', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await seedMarkdown(index, 'tree/folder', 'the parent')
    await seedMarkdown(index, 'tree/folder/child', 'the child')
    const sourceId = await seedMarkdown(index, 'tree/daily', 'see [[tree/folder/child]]')

    const source = createLocalFilesSource({ index })
    await source.renameDocumentPath('tree/folder', 'tree/archive')

    expect(await bodyOf(sourceId)).toBe('see [[tree/archive/child]]')
  })
})
