/**
 * The replica page's edits exist nowhere but this browser (the daemon that
 * would keep them is unreachable), so a refused append has to be SAID — a
 * markdown body that reads as saved while its ops will never be pushed is the
 * worst answer this page can give. The store is replaced by a double here
 * because the subject is what the page does with a rejected save, not
 * IndexedDB; the real record is `ReplicaReadPage.browser.test.tsx`'s.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPLICA_SAVE_FAILED_COPY } from '../lib/replica-state-copy.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FB0'
const DOC_MD = '01ARZ3NDEKTSV4RRFFQ69G5FB1'
const DAEMON = 'http://127.0.0.1:3099'

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

// A controlled textarea: the page's contract with the editor is `value` and
// `onChange`, which is all this suite drives.
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

async function openPlanAndEdit(): Promise<void> {
  render(
    <ReplicaReadPage
      workspaceId={DAEMON_WS}
      daemonBaseUrl={DAEMON}
      onReconnect={() => Promise.resolve()}
    />,
  )
  fireEvent.click(await screen.findByText('plan'))
  const editor = await screen.findByTestId('body-editor')
  fireEvent.change(editor, { target: { value: 'cached body, edited offline' } })
}

describe('ReplicaReadPage save failure', () => {
  beforeEach(() => {
    store.record = seedRecord()
    store.save.mockReset()
  })
  afterEach(() => {
    cleanup()
  })

  it('says the edit is not saved, and logs why, when the append is refused', async () => {
    store.save.mockRejectedValue(new Error('QuotaExceededError'))
    await openPlanAndEdit()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(REPLICA_SAVE_FAILED_COPY.title)
    await expectLoggedFailure('replica save failed')
    // The edit itself is untouched: the in-memory record still holds it.
    expect(readMarkdownBody(documentContainers(store.record as LoroDoc, DOC_MD))).toBe(
      'cached body, edited offline',
    )
  })

  it('keeps saying it until a later save lands, then clears', async () => {
    store.save.mockRejectedValueOnce(new Error('QuotaExceededError'))
    store.save.mockResolvedValue(undefined)
    await openPlanAndEdit()
    await screen.findByRole('alert')
    await expectLoggedFailure('replica save failed')

    fireEvent.click(screen.getByRole('button', { name: REPLICA_SAVE_FAILED_COPY.action }))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(store.save).toHaveBeenCalledTimes(2)
  })

  it('shows nothing while saves land', async () => {
    store.save.mockResolvedValue(undefined)
    await openPlanAndEdit()
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
