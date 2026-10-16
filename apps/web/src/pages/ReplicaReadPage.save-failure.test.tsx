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
import { KeeperNotices } from '../components/connection/KeeperNotices.js'
import { nothingHeldInTab } from '../lib/nothing-held-in-tab.js'
import { REPLICA_SAVE_FAILED_COPY } from '../lib/replica-state-copy.js'
import { getShellConnection, resetShellStatusForTests } from '../lib/shell-status-store.js'
import { stubAppBadge } from '../test-utils/app-badge.js'
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
  // Beside the shell's notices, as every frame that holds a page mounts
  // them: the leave prompt is theirs, read from the one shell store.
  render(
    <>
      <KeeperNotices />
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        daemonBaseUrl={DAEMON}
        onReconnect={() => Promise.resolve()}
      />
    </>,
  )
  fireEvent.click(await screen.findByText('plan'))
  const editor = await screen.findByTestId('body-editor')
  fireEvent.change(editor, { target: { value: 'cached body, edited offline' } })
}

function leaveIsPrevented(): boolean {
  const leave = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(leave)
  return leave.defaultPrevented
}

/**
 * Starts watching the DOM and answers, once an alert is on screen, what the
 * tab-wide readers said at the first mutation that put it there. Read inside
 * the observer because that is the earliest anything outside React can look:
 * a reader that waits for `findByRole` lets later work land first and so
 * cannot see a notice shown while the tab is not yet held.
 */
function watchHeldWhenAlertAppears(): { heldAtAlert: () => boolean | undefined; stop: () => void } {
  let held: boolean | undefined
  const observer = new MutationObserver(() => {
    if (held !== undefined || document.querySelector('[role="alert"]') === null) return
    held = !nothingHeldInTab()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return { heldAtAlert: () => held, stop: () => observer.disconnect() }
}

describe('ReplicaReadPage save failure', () => {
  beforeEach(() => {
    store.record = seedRecord()
    store.save.mockReset()
  })
  afterEach(() => {
    cleanup()
    resetShellStatusForTests()
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

  it('holds the tab while a refused edit is its only copy, and lets go once a save lands', async () => {
    store.save.mockRejectedValueOnce(new Error('QuotaExceededError'))
    store.save.mockResolvedValue(undefined)
    await openPlanAndEdit()
    await screen.findByRole('alert')
    await expectLoggedFailure('replica save failed')

    // What an unasked reload (a waiting update) and closing the tab both read.
    expect(nothingHeldInTab()).toBe(false)
    expect(leaveIsPrevented()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: REPLICA_SAVE_FAILED_COPY.action }))
    // Polled: the retried save lands asynchronously after the click.
    await vi.waitFor(() => expect(nothingHeldInTab()).toBe(true))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(leaveIsPrevented()).toBe(false)
  })

  it('holds the tab in the same commit that shows the refusal', async () => {
    store.save.mockRejectedValue(new Error('QuotaExceededError'))
    const watch = watchHeldWhenAlertAppears()
    try {
      await openPlanAndEdit()
      await screen.findByRole('alert')
      await expectLoggedFailure('replica save failed')
      expect(watch.heldAtAlert()).toBe(true)
    } finally {
      watch.stop()
    }
  })

  it('says nothing to the shell once the page is gone', async () => {
    store.save.mockRejectedValue(new Error('QuotaExceededError'))
    await openPlanAndEdit()
    await screen.findByRole('alert')
    await expectLoggedFailure('replica save failed')
    cleanup()
    expect(getShellConnection()).toBeNull()
  })

  it('sets the app badge while a refused edit is the only copy', async () => {
    const badge = stubAppBadge()
    try {
      store.save.mockRejectedValue(new Error('QuotaExceededError'))
      await openPlanAndEdit()
      expect(badge.set).not.toHaveBeenCalled()
      await screen.findByRole('alert')
      await expectLoggedFailure('replica save failed')
      // jsdom draws no favicon, but the badge is set from the same state.
      await vi.waitFor(() => expect(badge.set).toHaveBeenCalledTimes(1))
    } finally {
      badge.restore()
    }
  })

  it('shows nothing while saves land', async () => {
    store.save.mockResolvedValue(undefined)
    await openPlanAndEdit()
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
