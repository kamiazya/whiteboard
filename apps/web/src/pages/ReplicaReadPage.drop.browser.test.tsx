/**
 * A file dropped or a picture pasted on the offline replica's canvas. The
 * replica stores no pictures while the daemon is away, so its editor has no
 * image seam — and a drop that nothing cancels is opened by the browser in
 * place of the page, whose content key lives only in memory.
 */

import { forgetAllForTests } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64Url } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { connectReplicaKeeper, markReplica } from '../lib/replica-store.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

claimIsolatedWhiteboardDb('replica-read-page-drop')

const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FE0'
const DOC_SP = '01ARZ3NDEKTSV4RRFFQ69G5FE1'
const DAEMON = 'http://127.0.0.1:3096'

function offlineKeyFetch(): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.endsWith('/replica-key')) {
      return jsonResponse({
        workspaceKey: bytesToBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i + 21)),
        workspaceKeySalt: bytesToBase64Url(Uint8Array.from({ length: 16 }, (_, i) => 0xd0 + i)),
        tier: 'offline',
      })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}

async function seedSketch(): Promise<void> {
  connectReplicaKeeper({ baseUrl: DAEMON, fetch: offlineKeyFetch() })
  markReplica(DAEMON_WS, DAEMON)
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'sketch', documentId: DOC_SP, kind: 'spatial' })
  writeSpatialCanvas(documentContainers(record, DOC_SP), {
    nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 120, height: 40, text: 'cached node' })],
    edges: [],
  })
  record.commit()
  await new BrowserWorkspaceDocs().save(DAEMON_WS, record)
}

beforeEach(clearWhiteboardDb)
afterEach(() => {
  connectReplicaKeeper(null)
  forgetAllForTests()
  cleanup()
})

it('a dropped or pasted picture is cancelled and refused aloud', async () => {
  await seedSketch()
  render(
    <div style={{ width: 900, height: 600 }}>
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        daemonBaseUrl={DAEMON}
        onReconnect={async () => {}}
      />
    </div>,
  )
  await userEvent.click(await screen.findByText('sketch'))
  const editor = await screen.findByTestId('spatial-editor')
  const png = new File([new Uint8Array([137, 80, 78, 71])], 'pic.png', { type: 'image/png' })
  const files = new DataTransfer()
  files.items.add(png)
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: files })
  const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: files })
  const paste = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: files,
  })

  editor.dispatchEvent(over)
  editor.dispatchEvent(drop)
  editor.dispatchEvent(paste)

  expect([over.defaultPrevented, drop.defaultPrevented, paste.defaultPrevented]).toEqual([
    true,
    true,
    true,
  ])
  await vi.waitFor(() =>
    expect(screen.getByTestId('image-notice').textContent).toBe(
      "Images can't be added to this canvas.",
    ),
  )
})
