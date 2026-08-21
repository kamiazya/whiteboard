/**
 * Daemon-mode markdown 導線 (real CodeMirror): a markdown-kind document
 * served by the daemon opens in the markdown editor, and typing into it
 * reaches the backend as ordinary local updates on the SAME doc the
 * snapshot hydrated — the sync session's forwarding, not a second write
 * path. The backend is fake (this suite's subject is the page wiring, not
 * the transport); MarkdownEditor is REAL because CodeMirror's input path
 * is exactly what jsdom cannot exercise.
 */

import {
  MARKDOWN_BODY_KEY,
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import '../index.css'
import { focusEditable } from '../test-utils/focus-editable.js'

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
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

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  return {
    ...actual,
    SpatialEditor: (_props: { canvas: SpatialCanvas }) => <div data-testid="mock-spatial-editor" />,
  }
})

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

class FakeBackend implements DocumentBackend {
  readonly pushed: Uint8Array[] = []
  // The exact bytes the page hydrated from: the replay assertion must
  // import updates into the SAME doc lineage, not a structurally-equal
  // rebuild with different Loro op ids.
  snapshot: Uint8Array = new Uint8Array()
  connect(handlers: DocumentBackendHandlers): void {
    handlers.onConnected()
    this.snapshot = markdownSnapshot()
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

describe('DaemonDocumentPage markdown editing', () => {
  beforeEach(() => {
    // Only the keys this page reads: clear() would wipe origin-shared
    // state out from under concurrently-running files.
    window.localStorage.removeItem('whiteboard.markdown-view-mode')
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [{ path: 'agent-note', id: 'id-note', updatedAt: '2026-01-01', kind: 'markdown' }],
    })
  })
  afterEach(() => {
    cleanup()
    // Only the keys this page reads: clear() would wipe origin-shared
    // state out from under concurrently-running files.
    window.localStorage.removeItem('whiteboard.markdown-view-mode')
    vi.clearAllMocks()
  })

  it('typing into the daemon markdown editor pushes the edit to the backend as a doc update', async () => {
    const backend = new FakeBackend()
    render(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId="w1"
        path="agent-note"
        createBackend={() => backend}
      />,
    )

    // Markdown editor mounts with the daemon-held body; spatial never does.
    await waitFor(
      () => {
        expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
      },
      { timeout: 10_000 },
    )
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toBe(BODY)
    })
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()

    const resolveEditable = () => document.querySelector('[contenteditable="true"]')
    await focusEditable(resolveEditable)
    await waitFor(() => expect(document.activeElement).toBe(resolveEditable()), {
      timeout: 10_000,
    })
    // A click lands the cursor wherever the pointer hit; pin it to the end
    // so the typed suffix has one deterministic destination.
    await userEvent.keyboard('{Control>}{End}{/Control}')
    // ASCII only: a character with no keycode (an em dash, say) is
    // synthesized separately from the plain keystrokes around it, and under
    // load it is the one that goes missing — observed as
    // `'# Hello from an agent  edited here'`, both spaces present and the
    // dash gone, which reads like a lost edit rather than a lost keystroke.
    await userEvent.keyboard(' - edited here')

    // The edit reaches the backend through the session's own local-update
    // forwarding: replaying pushed updates over the original snapshot must
    // yield the typed body in the `body` text container. Asserted on the
    // container directly rather than through `readMarkdownBody`, whose node
    // fallback would also accept a body written the old way.
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
})
