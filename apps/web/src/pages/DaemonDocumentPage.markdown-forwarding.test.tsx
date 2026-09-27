/**
 * A body edit in daemon mode reaches the backend through the sync session's
 * own local-update forwarding. The page installs a binding that writes each
 * edit into the session's doc at its own position (no whole-text
 * `set-body`), and the session's commit is what pushes. The editor is a
 * stub that mounts a real CodeMirror view with the extensions the page
 * hands it, because the subject here is the PAGE WIRING between editor and
 * session; what a burst costs and whether a passage keeps its mark is
 * `lib/markdown-write-path.instrument.test.ts`.
 */

import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  MARKDOWN_BODY_KEY,
  MARKDOWN_BODY_NODE_ID,
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listDocuments: vi.fn(),
    createDocument: vi.fn(),
  }
})

// The stub keeps MarkdownEditor's controlled contract (`value`/`onChange`)
// and nothing else — one textarea, no CodeMirror.
const mounted = vi.hoisted(() => ({ views: [] as import('@codemirror/view').EditorView[] }))

vi.mock('../components/markdown-editor/MarkdownEditor.js', async () => {
  const { EditorState } = await import('@codemirror/state')
  const { EditorView } = await import('@codemirror/view')
  const { useEffect, useRef } = await import('react')
  return {
    MarkdownEditor: (props: {
      value: string
      sourceExtensions?: import('@codemirror/state').Extension
    }) => {
      const host = useRef<HTMLDivElement | null>(null)
      // Mounted once per key, as the real editor is.
      useEffect(() => {
        if (host.current === null) return
        const view = new EditorView({
          state: EditorState.create({
            doc: props.value,
            extensions: props.sourceExtensions ?? [],
          }),
          parent: host.current,
        })
        mounted.views.push(view)
        return () => view.destroy()
      }, [])
      return (
        <div
          data-testid="markdown-source-stub"
          data-bound={props.sourceExtensions === undefined ? 'no' : 'yes'}
          ref={host}
        />
      )
    },
  }
})

// This page schedules ADR-0023's replica pull and push in the background, on
// an idle callback or a 1.5s timer. Nothing here is about replica caching, so
// the schedulers are stubbed: left real they run mid-file against a fetch mock
// shaped for something else, and the warning that follows is charged to
// whichever case is executing by then
// (`issues/replica-refresh-warning-lands-on-a-later-test`). Each answers the
// CANCEL the page calls on unmount.
vi.mock('../lib/replica-refresh.js', () => ({
  scheduleReplicaRefresh: vi.fn(() => () => {}),
  scheduleReplicaPush: vi.fn(() => () => {}),
}))

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

const BODY = '# Hello from an agent'

/** The daemon shape: body in the `body` text container, kind on the doc. */
function markdownSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, BODY)
  writeCoreFacets(doc, { type: 'markdown' })
  writeDocumentKind(doc, 'markdown')
  return doc.export({ mode: 'snapshot' })
}

/**
 * The shape before the writers were unified: the body stored as the
 * `okf-body` TEXT NODE of a canvas, the `body` container empty. Still on
 * disk wherever an older `wb_document_set` wrote a note.
 */
function preUnificationSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [
      textNode({ id: MARKDOWN_BODY_NODE_ID, x: 0, y: 0, width: 400, height: 200, text: BODY }),
    ],
    edges: [],
  })
  writeCoreFacets(doc, { type: 'markdown' })
  writeDocumentKind(doc, 'markdown')
  return doc.export({ mode: 'snapshot' })
}

class FakeBackend implements DocumentBackend {
  readonly pushed: Uint8Array[] = []
  // The exact bytes the page hydrated from: the replay assertion must
  // import updates into the SAME doc lineage, not a structurally-equal
  // rebuild with different Loro op ids.
  snapshot: Uint8Array = new Uint8Array()
  constructor(private readonly seed: () => Uint8Array = markdownSnapshot) {}
  connect(handlers: DocumentBackendHandlers): void {
    handlers.onConnected()
    this.snapshot = this.seed()
    handlers.onSnapshot(this.snapshot)
  }
  disconnect(): void {}
  pushLocalUpdate(update: Uint8Array): void {
    this.pushed.push(update)
  }
  getFile(): Promise<Blob | null> {
    return Promise.resolve(null)
  }
  putFile(): Promise<void> {
    return Promise.resolve()
  }
  sendClientReady(): void {}
  sendExportResponse(): void {}
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

describe('DaemonDocumentPage markdown sync forwarding', () => {
  beforeEach(() => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [{ path: 'agent-note', id: 'id-note', updatedAt: '2026-01-01', kind: 'markdown' }],
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('a body edit pushes the update to the backend on the hydrated doc lineage', async () => {
    mounted.views.length = 0
    const backend = new FakeBackend()
    render(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId="w1"
        path="agent-note"
        createBackend={() => backend}
      />,
    )

    // The editor mounts BOUND once the snapshot hydrates, on the daemon-held
    // body: the binding is what writes, not the surface's `setBody`.
    const editor = await screen.findByTestId('markdown-source-stub', undefined, {
      timeout: 10_000,
    })
    await waitFor(() => expect(editor.dataset.bound).toBe('yes'))
    const view = mounted.views.at(-1)
    if (view === undefined) throw new Error('no editor view mounted')
    expect(view.state.doc.toString()).toBe(BODY)

    view.dispatch({ changes: { from: view.state.doc.length, insert: ' - edited here' } })

    // Replaying pushed updates over the original snapshot must yield the
    // edited body in the `body` text container. Asserted on the container
    // directly rather than through `readMarkdownBody`, whose node fallback
    // would also accept a body written the old way.
    await waitFor(
      () => {
        expect(backend.pushed.length).toBeGreaterThan(0)
        const replay = new LoroDoc()
        replay.import(backend.snapshot)
        for (const update of backend.pushed) replay.import(update)
        expect(replay.getText(MARKDOWN_BODY_KEY).toString()).toBe(`${BODY} - edited here`)
      },
      { timeout: 10_000 },
    )
  })

  it('opens a pre-unification note on its prose, and an edit keeps it', async () => {
    // The body lives in a canvas text node and the `body` container is empty.
    // A binding reconciles the editor FROM the container on mount, so without
    // a conversion the prose left the editor and the first keystroke wrote a
    // one-character container that hid it (the container wins on read).
    mounted.views.length = 0
    const backend = new FakeBackend(preUnificationSnapshot)
    render(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId="w1"
        path="agent-note"
        createBackend={() => backend}
      />,
    )
    const editor = await screen.findByTestId('markdown-source-stub', undefined, {
      timeout: 10_000,
    })
    await waitFor(() => expect(editor.dataset.bound).toBe('yes'))
    const view = mounted.views.at(-1)
    if (view === undefined) throw new Error('no editor view mounted')
    // After the binding's first reconcile, not just at construction.
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(view.state.doc.toString()).toBe(BODY)

    view.dispatch({ changes: { from: view.state.doc.length, insert: ' - edited here' } })

    await waitFor(
      () => {
        const replay = new LoroDoc()
        replay.import(backend.snapshot)
        for (const update of backend.pushed) replay.import(update)
        expect(replay.getText(MARKDOWN_BODY_KEY).toString()).toBe(`${BODY} - edited here`)
      },
      { timeout: 10_000 },
    )
  })
})
