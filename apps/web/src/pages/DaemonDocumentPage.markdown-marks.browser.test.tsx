/**
 * A comment's passage on a daemon-kept note keeps its mark through the edits
 * a person actually makes — typing in two places in quick succession, one of
 * them inside the passage — and so stays attached.
 *
 * The mark is what lets a thread follow its passage through an edit INSIDE
 * it; the thread's quote is only the fallback, and it stops matching the
 * moment the quoted words change. While the daemon editor handed the session
 * whole texts, a burst at two places collapsed to one span re-inserting
 * everything between them, the passage's mark included — silently, because
 * the quote still matched and a lost mark is re-derived from it. It shows
 * when the same burst ALSO changes the passage: the mark is gone and the
 * quote no longer matches, so the thread is marked orphaned over a passage
 * that is plainly still there.
 *
 * Real browser, real CodeMirror, the real page; the daemon behind it is a
 * fake backend holding the note.
 */

import { EditorView } from '@codemirror/view'
import {
  writeCommentThread,
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../index.css'
import { FakeDocumentBackend, renderPage } from '../test-utils/daemon-page-harness.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const { daemonApiClientMock, daemonWithOneDocument } = await import(
    '../test-utils/daemon-page-harness.js'
  )
  return daemonApiClientMock(
    importOriginal,
    ['listWorkspaces', 'listDocuments', 'createDocument', 'getDocumentBacklinks'],
    daemonWithOneDocument({ path: 'note', id: 'id-note', kind: 'markdown' }),
  )
})

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const PASSAGE = 'report on Friday'
const BODY = `Opening line. Ship the ${PASSAGE}, the draft is not written. Closing line.`
const AT = { start: BODY.indexOf(PASSAGE), end: BODY.indexOf(PASSAGE) + PASSAGE.length }

function noteSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, BODY)
  writeCoreFacets(doc, { type: 'markdown' })
  writeDocumentKind(doc, 'markdown')
  writeCommentThread(doc, {
    id: 't-passage',
    anchor: { kind: 'text', quote: { exact: PASSAGE }, ...AT },
    status: 'open',
    messages: [{ id: 'm1', body: 'is Friday realistic?' }],
  })
  return doc.export({ mode: 'snapshot' })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('keeps a passage attached through one burst that also edits inside it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404 })),
  )
  const backend = new FakeDocumentBackend(noteSnapshot)
  renderPage(
    <DaemonDocumentPage
      daemonBaseUrl="http://127.0.0.1:3099"
      workspaceId="w1"
      path="note"
      createBackend={() => backend}
    />,
  )

  const content = await waitFor(
    () => {
      const found = document.querySelector<HTMLElement>('.cm-content')
      if (found === null || !found.textContent?.includes(PASSAGE)) throw new Error('no editor yet')
      return found
    },
    { timeout: 15_000 },
  )
  const view = EditorView.findFromDOM(content)
  if (view === null) throw new Error('no CodeMirror view on the editor')

  // One burst, well inside the session's 300ms window: a word typed at the
  // top, the passage's FIRST word changed, and a mark typed just past its
  // end. The quote stops matching once 'report' goes, so only the mark can
  // keep the thread attached; a whole-text write spans the top to past the
  // passage — nothing of it left outside the span to keep a mark on.
  view.dispatch({ changes: { from: 0, insert: 'Note: ' } })
  const report = view.state.doc.toString().indexOf('report')
  view.dispatch({ changes: { from: report, to: report + 'report'.length, insert: 'memo' } })
  const after = view.state.doc.toString().indexOf('Friday') + 'Friday'.length
  view.dispatch({ changes: { from: after, insert: '!' } })
  // The burst's commit is what pushes; waiting for the push is waiting for
  // the burst to be in the document the rail reads.
  const pushedBefore = backend.pushed.length
  await waitFor(() => expect(backend.pushed.length).toBeGreaterThan(pushedBefore), {
    timeout: 5_000,
  })

  await userEvent.click(await screen.findByRole('button', { name: /comments/i }))
  await waitFor(() => expect(screen.getByText('is Friday realistic?')).toBeInTheDocument(), {
    timeout: 15_000,
  })
  expect(screen.queryByTestId('thread-orphaned-t-passage')).toBeNull()
})
