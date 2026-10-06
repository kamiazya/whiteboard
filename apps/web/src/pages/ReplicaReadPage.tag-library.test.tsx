/**
 * The offline page draws the same workspace the online pages do, so a board
 * on it — or inside a note on it — is coloured by the workspace's tag library
 * too. The library is read out of the replica record itself (the document at
 * `tags`), since the keeper that would answer it is the one that is away.
 * The editors are doubles that record what they were handed: the subject is
 * the page's wiring, and the colouring itself is canvas-render's to pin.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { TAG_LIBRARY_PATH, VISUAL_TAGS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReplicaReadPage } from './ReplicaReadPage.js'

const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FB0'
const DOC_MD = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const DOC_BOARD = '01ARZ3NDEKTSV4RRFFQ69G5FB2'
const DOC_TAGS = '01ARZ3NDEKTSV4RRFFQ69G5FB3'
const DAEMON = 'http://127.0.0.1:3099'

const store = vi.hoisted(() => ({
  record: null as import('loro-crdt').LoroDoc | null,
  handed: { markdown: undefined as unknown, spatial: undefined as unknown },
}))

vi.mock('../lib/browser-workspace-docs.js', () => ({
  BrowserWorkspaceDocs: class {
    open = async () => store.record
    save = async () => {}
  },
}))

vi.mock('../components/markdown-editor/MarkdownEditor.js', () => ({
  MarkdownEditor: (props: { tagLibrary?: unknown }) => {
    store.handed.markdown = props.tagLibrary
    return <div data-testid="markdown-editor" />
  },
}))

vi.mock('../components/spatial-editor/SpatialEditor.js', () => ({
  SpatialEditor: (props: { tagLibrary?: unknown }) => {
    store.handed.spatial = props.tagLibrary
    return <div data-testid="spatial-editor" />
  },
}))

const DECLARED = { health: { values: { failing: { color: '1' } } } }

function seedRecord(withLibrary: boolean): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'plan', documentId: DOC_MD, kind: 'markdown' })
  writeMarkdownBody(documentContainers(record, DOC_MD), `![[${DOC_BOARD}]]`)
  createWorkspaceDocumentAtPath(record, { path: 'board', documentId: DOC_BOARD, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(record, DOC_BOARD), {
    nodes: [
      textNode({
        id: 'db',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        text: 'db',
        tags: ['health:failing'],
      }),
    ],
    edges: [],
  })
  if (withLibrary) {
    createWorkspaceDocumentAtPath(record, {
      path: TAG_LIBRARY_PATH,
      documentId: DOC_TAGS,
      kind: 'markdown',
    })
    writeFacets(documentContainers(record, DOC_TAGS), { [VISUAL_TAGS_KEY]: { keys: DECLARED } })
  }
  record.commit()
  return record
}

async function open(path: string): Promise<void> {
  render(
    <ReplicaReadPage
      workspaceId={DAEMON_WS}
      daemonBaseUrl={DAEMON}
      onReconnect={() => Promise.resolve()}
    />,
  )
  fireEvent.click(await screen.findByText(path))
}

describe('ReplicaReadPage and the workspace tag library', () => {
  beforeEach(() => {
    store.handed = { markdown: undefined, spatial: undefined }
  })
  afterEach(() => {
    cleanup()
  })

  it("hands a note's preview the library the replica's tags document declares", async () => {
    store.record = seedRecord(true)
    await open('plan')
    await screen.findByTestId('markdown-editor')
    expect(store.handed.markdown).toMatchObject({ health: { values: { failing: { color: '1' } } } })
  })

  it('hands a board the same library', async () => {
    store.record = seedRecord(true)
    await open('board')
    await screen.findByTestId('spatial-editor')
    expect(store.handed.spatial).toMatchObject({ health: { values: { failing: { color: '1' } } } })
  })

  it('hands an empty library when the replica holds no tags document', async () => {
    store.record = seedRecord(false)
    await open('board')
    await screen.findByTestId('spatial-editor')
    expect(store.handed.spatial).toEqual({})
  })
})
