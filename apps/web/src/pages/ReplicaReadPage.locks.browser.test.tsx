/**
 * Element locks on the offline replica. A lock lives in the workspace record
 * beside the canvas, and the replica IS that record — so a node locked on the
 * daemon stays locked here, and an edit made here cannot reach it. Without
 * this an offline visit could move or delete a locked node, and the change
 * would ship to the daemon as ordinary ops once it returned.
 */

import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readNodeLocks,
  readSpatialCanvas,
  setNodeLock,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { connectReplicaKeeper } from '../lib/replica-store.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedReplicaRecord } from '../test-utils/replica-key-fetch.js'
import { rootOf } from '../test-utils/spatial-editor-root.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

claimIsolatedWhiteboardDb('replica-read-page-locks')

const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FC0'
const DOC_SP = '01ARZ3NDEKTSV4RRFFQ69G5FC1'
const DAEMON = 'http://127.0.0.1:3098'

/** A sealed replica holding one canvas: a locked node and a free one. */
async function seedLockedCanvas(): Promise<void> {
  await seedReplicaRecord({
    daemonBaseUrl: DAEMON,
    workspaceId: DAEMON_WS,
    build: (record) => {
      createWorkspaceDocumentAtPath(record, { path: 'sketch', documentId: DOC_SP, kind: 'spatial' })
      const containers = documentContainers(record, DOC_SP)
      writeSpatialCanvas(containers, {
        nodes: [
          textNode({ id: 'held', x: 40, y: 40, width: 160, height: 80, text: 'held node' }),
          textNode({ id: 'free', x: 320, y: 40, width: 160, height: 80, text: 'free node' }),
        ],
        edges: [],
      })
      setNodeLock(containers, 'held', true)
    },
  })
}

async function savedRecord() {
  const record = await new BrowserWorkspaceDocs().open(DAEMON_WS)
  if (record === null) throw new Error('replica record missing')
  return documentContainers(record, DOC_SP)
}

/** The editor surface, and the screen centre of a node found by its text. */
async function openSketch() {
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
  const centreOf = async (text: string) => {
    const rect = (await screen.findByText(text)).getBoundingClientRect()
    return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
  }
  return { view, root, centreOf }
}

function pressAt(root: HTMLElement, at: { clientX: number; clientY: number }) {
  fireEvent.pointerDown(root, { button: 0, pointerId: 1, ...at })
  fireEvent.pointerUp(root, { pointerId: 1, ...at })
}

beforeEach(clearWhiteboardDb)
afterEach(() => {
  connectReplicaKeeper(null)
  forgetAllForTests()
  cleanup()
})

it('a locked node is unselectable offline, and Delete leaves it in the saved replica', async () => {
  await seedLockedCanvas()
  const { view, root, centreOf } = await openSketch()

  pressAt(root, await centreOf('held node'))
  expect(view.container.querySelector('[data-testid="selection-overlay"]')).toBeNull()

  // Select-all then Delete: the free node goes, which is what proves a save
  // happened at all; the locked one must not go with it.
  fireEvent.keyDown(root, { code: 'KeyA', key: 'a', ctrlKey: true, metaKey: true })
  fireEvent.keyDown(root, { key: 'Delete' })
  view.unmount()

  await vi.waitFor(async () => {
    const ids = readSpatialCanvas(await savedRecord()).nodes.map((n) => n.id)
    expect(ids).toEqual(['held'])
  })
})

it('Unlock from the context menu persists to the replica record', async () => {
  await seedLockedCanvas()
  const { view, root, centreOf } = await openSketch()

  fireEvent.contextMenu(root, await centreOf('held node'))
  const unlock = [...view.container.querySelectorAll('[data-testid="context-menu"] button')].find(
    (el) => el.textContent === 'Unlock',
  )
  expect(unlock).toBeDefined()
  fireEvent.click(unlock as HTMLElement)

  // Released in the editor at once: a press now selects it.
  pressAt(root, await centreOf('held node'))
  expect(view.container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()
  view.unmount()

  await vi.waitFor(async () => {
    expect([...readNodeLocks(await savedRecord())]).toEqual([])
  })
})
