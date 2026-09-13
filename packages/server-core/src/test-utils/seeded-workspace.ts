/**
 * One seeded in-memory workspace for the fuzz lanes — the tool lane and the
 * route lane draw ids from the same board, so a finding in one reproduces
 * in the other: a spatial document with two text nodes (one three lines
 * long), a group, an edge and a comment; a markdown document with
 * frontmatter, a document facet and a body naming the board; one saved
 * version of the board.
 */

import {
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { LoroDoc } from 'loro-crdt'
import { createServer } from '../create-server.js'
import { FakeDocumentStore, seedDoc } from './fake-document-store.js'
import { FakeLiveDocuments } from './fake-live-documents.js'
import { FakeVersionHistory } from './fake-version-history.js'
import { makeTestDeps } from './make-test-deps.js'
import { inMemoryDocumentTeardown } from './unused-document-teardown.js'

export const SEEDED_WORKSPACE_ID = 'ws-1'
export const SEEDED_SPATIAL_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
export const SEEDED_MARKDOWN_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
/** A well-formed id that names nothing. */
export const MISSING_DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V9'
export const SEEDED_SPATIAL_PATH = 'board'
export const SEEDED_MARKDOWN_PATH = 'notes/plan'

export async function seededServer(): Promise<ReturnType<typeof createServer>> {
  const store = new FakeDocumentStore()
  let board: LoroDoc | undefined
  await seedDoc(store, SEEDED_SPATIAL_ID, (doc) => {
    board = doc
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, {
      nodes: [
        textNode({ id: 'n1', x: 0, y: 0, width: 200, height: 80, text: 'one\ntwo\nthree' }),
        textNode({ id: 'n2', x: 400, y: 0, width: 200, height: 80, text: 'two' }),
        groupNode({ id: 'g1', x: -20, y: 200, width: 640, height: 200, label: 'later' }),
      ],
      edges: [
        {
          id: 'e1',
          from: { node: 'n1' },
          to: { node: 'n2' },
        },
      ],
      // One stroke of INK, so the `line.*` ops have something to patch and
      // remove. Without it those arms are declared reachable and are only
      // ever refused for want of an id, which reads as a broken op rather
      // than as an empty fixture (ADR-0038 decision 2).
      lines: [
        {
          id: 'l1',
          from: { kind: 'node', node: 'n1' },
          to: { kind: 'point', point: { x: 700, y: 300 } },
        },
      ],
      comments: [{ id: 'c1', x: 10, y: 10, text: 'why?', targetNodeId: 'n1' }],
    })
  })
  await seedDoc(store, SEEDED_MARKDOWN_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeCoreFacets(doc, { type: 'note', tags: ['seed'] })
    writeFacets(doc, { 'visual.symbol/v0': { kind: 'emoji', char: '📝' } })
    writeMarkdownBody(
      doc,
      `# Plan\n\nA paragraph about the Board, with [[${SEEDED_SPATIAL_ID}]] in it.\n`,
    )
  })
  store.documentIndex.seed({
    workspaceId: SEEDED_WORKSPACE_ID,
    documentId: SEEDED_SPATIAL_ID,
    path: SEEDED_SPATIAL_PATH,
    kind: 'spatial',
    // Named, and named in the note's prose, so linkify has a mention to find.
    name: 'Board',
  })
  store.documentIndex.seed({
    workspaceId: SEEDED_WORKSPACE_ID,
    documentId: SEEDED_MARKDOWN_ID,
    path: SEEDED_MARKDOWN_PATH,
    kind: 'markdown',
    name: 'Plan',
  })
  const versions = new FakeVersionHistory()
  if (board === undefined) throw new Error('seedDoc did not configure the board')
  // One saved version, so restore and list have something to name ('v1').
  await versions.save(SEEDED_WORKSPACE_ID, SEEDED_SPATIAL_PATH, board, {
    auto: false,
    label: 'seed',
  })
  const deps = makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    documentTeardown: inMemoryDocumentTeardown(),
    versions,
    liveDocuments: new FakeLiveDocuments(),
  })
  return createServer(deps)
}
