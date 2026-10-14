/**
 * A workspace stencil on the offline replica. The library is a document in
 * the workspace record, and the replica IS that record — so the editor here
 * knows the workspace's stencils exactly as the keeper pages do. Without
 * that, taking a workspace stencil off a node removes only its record and
 * leaves the stencil's colour and silhouette behind, and the mixed box ships
 * to the daemon once it returns.
 */

import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readSpatialCanvas,
  writeFacets,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { STENCIL_LIBRARY_PATH, VISUAL_STENCILS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { connectReplicaKeeper } from '../lib/replica-store.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedReplicaRecord } from '../test-utils/replica-key-fetch.js'
import { rootOf } from '../test-utils/spatial-editor-root.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

claimIsolatedWhiteboardDb('replica-read-page-stencil')

const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FD0'
const DOC_SP = '01ARZ3NDEKTSV4RRFFQ69G5FD1'
const DOC_STENCILS = '01ARZ3NDEKTSV4RRFFQ69G5FD2'
const DAEMON = 'http://127.0.0.1:3097'

/** A sealed replica whose library declares a coloured stencil, and a node wearing it. */
async function seedDressedNode(): Promise<void> {
  await seedReplicaRecord({
    daemonBaseUrl: DAEMON,
    workspaceId: DAEMON_WS,
    build: (record) => {
      createWorkspaceDocumentAtPath(record, {
        path: STENCIL_LIBRARY_PATH,
        documentId: DOC_STENCILS,
        kind: 'markdown',
      })
      writeFacets(documentContainers(record, DOC_STENCILS), {
        [VISUAL_STENCILS_KEY]: {
          stencils: {
            lakehouse: {
              displayName: 'Lakehouse',
              color: '3',
              facets: { 'visual.shape/v0': { kind: 'hexagon' } },
            },
          },
        },
      })
      createWorkspaceDocumentAtPath(record, { path: 'sketch', documentId: DOC_SP, kind: 'spatial' })
      writeSpatialCanvas(documentContainers(record, DOC_SP), {
        nodes: [
          textNode({
            id: 'lake',
            x: 40,
            y: 40,
            width: 200,
            height: 100,
            text: 'lake node',
            color: '3',
            facets: {
              'visual.shape/v0': { kind: 'hexagon' },
              'visual.stencil/v0': { stencil: 'workspace.lakehouse' },
            },
          }),
        ],
        edges: [],
      })
    },
  })
}

async function savedLake() {
  const record = await new BrowserWorkspaceDocs().open(DAEMON_WS)
  if (record === null) throw new Error('replica record missing')
  return readSpatialCanvas(documentContainers(record, DOC_SP)).nodes.find((n) => n.id === 'lake')
}

beforeEach(clearWhiteboardDb)
afterEach(() => {
  connectReplicaKeeper(null)
  forgetAllForTests()
  cleanup()
})

it('None takes a workspace stencil off with its colour and silhouette', async () => {
  await seedDressedNode()
  const view = render(
    <div style={{ width: 900, height: 600 }}>
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        daemonBaseUrl={DAEMON}
        onReconnect={async () => {}}
      />
    </div>,
  )
  fireEvent.click(await screen.findByText('sketch'))
  await screen.findByTestId('spatial-editor')
  const root = rootOf(view.container)
  const rect = (await screen.findByText('lake node')).getBoundingClientRect()
  fireEvent.contextMenu(root, {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  })
  const menu = await screen.findByTestId('context-menu')
  const entry = [...menu.querySelectorAll('button')].find((b) => b.textContent?.includes('Facets'))
  expect(entry).toBeDefined()
  fireEvent.click(entry as HTMLElement)
  const panel = await screen.findByTestId('facet-form-panel')
  // The library's own chip is offered — the registry knows the workspace stencil.
  expect(within(panel).getByRole('radio', { name: 'Lakehouse' })).toBeTruthy()
  fireEvent.click(within(panel).getByRole('radio', { name: 'None' }))
  view.unmount()

  await vi.waitFor(async () => {
    const lake = await savedLake()
    expect(lake?.facets ?? {}).toEqual({})
    expect(lake?.color).toBeUndefined()
  })
})
