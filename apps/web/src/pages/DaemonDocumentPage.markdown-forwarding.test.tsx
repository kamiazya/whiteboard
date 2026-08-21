/**
 * A body edit in daemon mode reaches the backend through the sync session's
 * own local-update forwarding — the ordinary `set-body` command path, not a
 * second write pipeline. The editor is a stub driving MarkdownEditor's
 * controlled `onChange`, because the subject here is the PAGE WIRING between
 * editor and session; CodeMirror's real input path is pinned independently
 * by loro-binding.browser.test.tsx.
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
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
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
vi.mock('../components/markdown-editor/MarkdownEditor.js', () => ({
  MarkdownEditor: (props: { value: string; onChange: (next: string) => void }) => (
    <textarea
      aria-label="markdown source stub"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
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
    const backend = new FakeBackend()
    render(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId="w1"
        path="agent-note"
        createBackend={() => backend}
      />,
    )

    // The stub mounts with the daemon-held body once the snapshot hydrates.
    const editor = await screen.findByRole(
      'textbox',
      { name: 'markdown source stub' },
      { timeout: 10_000 },
    )
    await waitFor(() => {
      expect((editor as HTMLTextAreaElement).value).toBe(BODY)
    })

    fireEvent.change(editor, { target: { value: `${BODY} - edited here` } })

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
})
