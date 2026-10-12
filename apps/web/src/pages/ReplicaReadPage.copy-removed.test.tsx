/**
 * The replica page holds the whole record in memory, so a copy deleted from
 * this browser in another tab is one its next save would write back. It
 * locks instead, whether it hears the removal or meets it as a refused save.
 * The store is a double here because the subject is what the page does when
 * it is told; what the store refuses is `browser-workspace-removal.replica.test.ts`'s.
 */
// fake-indexeddb only so the refusal below is the store's own, not a stand-in.
import 'fake-indexeddb/auto'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPLICA_COPY_REMOVED_COPY } from '../lib/replica-state-copy.js'
import { announceWorkspaceRemoved } from '../lib/workspace-broadcast.js'
import { refuseUnlessHeld } from '../lib/workspace-tombstone.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

claimIsolatedWhiteboardDb('replicareadpage-copyremoved')

const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FC0'
const DOC_MD = '01ARZ3NDEKTSV4RRFFQ69G5FC1'
const DAEMON = 'http://127.0.0.1:3099'
const OTHER_WS = '01ARZ3NDEKTSV4RRFFQ69G5FC2'

const store = vi.hoisted(() => ({
  record: null as import('loro-crdt').LoroDoc | null,
  save: vi.fn<(workspaceId: string, record: import('loro-crdt').LoroDoc) => Promise<void>>(),
}))

vi.mock('../lib/browser-workspace-docs.js', () => ({
  BrowserWorkspaceDocs: class {
    open = async () => store.record
    save = store.save
  },
}))

vi.mock('../components/markdown-editor/MarkdownEditor.js', () => ({
  MarkdownEditor: (props: { value: string; onChange: (next: string) => void }) => (
    <textarea
      data-testid="body-editor"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}))

function seedRecord(): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, { path: 'plan', documentId: DOC_MD, kind: 'markdown' })
  writeMarkdownBody(documentContainers(record, DOC_MD), 'cached body')
  record.commit()
  return record
}

async function openPlanAndEdit(): Promise<() => void> {
  const { unmount } = render(
    <ReplicaReadPage
      workspaceId={DAEMON_WS}
      daemonBaseUrl={DAEMON}
      onReconnect={() => Promise.resolve()}
    />,
  )
  fireEvent.click(await screen.findByText('plan'))
  const editor = await screen.findByTestId('body-editor')
  fireEvent.change(editor, { target: { value: 'cached body, edited offline' } })
  return unmount
}

describe('ReplicaReadPage when its copy is deleted elsewhere', () => {
  beforeEach(() => {
    store.record = seedRecord()
    store.save.mockReset()
  })
  afterEach(() => {
    cleanup()
  })

  it('locks on hearing it, and never saves the pending edit', async () => {
    store.save.mockResolvedValue(undefined)
    const unmount = await openPlanAndEdit()

    announceWorkspaceRemoved(DAEMON_WS)

    const notice = await screen.findByTestId('replica-state-copy-removed')
    expect(notice.textContent).toBe(REPLICA_COPY_REMOVED_COPY)
    expect(screen.queryByTestId('body-editor')).toBeNull()
    // The unmount flushes a waiting save, and the save runs a microtask later.
    await act(async () => unmount())
    expect(store.save).not.toHaveBeenCalled()
  })

  it('does not carry the lock to another workspace the same page goes on to show', async () => {
    store.save.mockResolvedValue(undefined)
    const { rerender } = render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        daemonBaseUrl={DAEMON}
        onReconnect={() => Promise.resolve()}
      />,
    )
    await screen.findByText('plan')
    announceWorkspaceRemoved(DAEMON_WS)
    await screen.findByTestId('replica-state-copy-removed')

    rerender(
      <ReplicaReadPage
        workspaceId={OTHER_WS}
        daemonBaseUrl={DAEMON}
        onReconnect={() => Promise.resolve()}
      />,
    )

    await screen.findByText('plan')
    expect(screen.queryByTestId('replica-state-copy-removed')).toBeNull()
  })

  it('locks when a save is refused because the copy is gone', async () => {
    // What a save meets once nothing here holds the id any more.
    const refusal = await refuseUnlessHeld(DAEMON_WS, false).catch((err: unknown) => err)
    store.save.mockRejectedValue(refusal)
    await openPlanAndEdit()

    await screen.findByTestId('replica-state-copy-removed')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
