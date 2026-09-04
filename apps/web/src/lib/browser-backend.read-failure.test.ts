/**
 * What the reader is TOLD when the workspace record does not come back.
 *
 * Two failures reach the same `catch`, and they are about different things:
 *
 * - the record is there and this build cannot make sense of it — a claim
 *   about the DATA, and the one `corrupt-snapshot` exists to make;
 * - the read did not complete at all — a blocked open (another tab holding
 *   this app at an older version, which `openWhiteboardDb` rejects by name),
 *   an aborted transaction, storage that went away. Nothing about the stored
 *   document is known, and saying it "could not be read" accuses intact data.
 *
 * The second one is not hypothetical: the page turns `corrupt-snapshot` into
 * a full-page "This canvas’s data could not be read." — the editor replaced
 * by a banner and a Start fresh button — so a reader whose second tab is
 * merely stale is shown their work as damaged. `document-read-failure.ts`
 * states the rule this breaks: every sentence there is about the STORAGE,
 * never about the document being missing.
 *
 * Worse than a wrong sentence: the page answers `corrupt-snapshot` with a
 * `Start fresh` button, which DELETES the record. Someone whose only problem
 * was a second tab is one click from losing the document.
 *
 * `read-unavailable` keeps the page-level treatment — the content did not
 * arrive either way, and an editor over an empty canvas would be its own lie
 * — and changes what is said and what is offered.
 */
import { StoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { describe, expect, it, vi } from 'vitest'
import { BrowserBackend } from './browser-backend.js'
import type { DocumentFileStore } from './document-file-store.js'
import type { LoroStore } from './loro-store.js'

const TARGET = {
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  path: 'notes/reviewed',
  kind: 'spatial' as const,
}

/** A workspace store whose every read fails with the given error. */
function docsFailingWith(error: unknown): WorkspaceDocs {
  return {
    open: () => Promise.reject(error),
    create: () => Promise.reject(error),
    save: () => Promise.reject(error),
    readCursor: () => Promise.reject(error),
    catchUp: () => Promise.reject(error),
  } as unknown as WorkspaceDocs
}

function connectAgainst(error: unknown): { reasons: string[] } {
  const reasons: string[] = []
  const legacy = { load: async () => ({ kind: 'not-found' }) as const } as unknown as LoroStore
  const files = {} as unknown as DocumentFileStore
  const backend = new BrowserBackend(TARGET, docsFailingWith(error), files, legacy)
  backend.connect({
    onConnected: () => {},
    onSnapshot: (_snapshot: Uint8Array) => {},
    onError: (reason: string) => reasons.push(reason),
  } as never)
  return { reasons }
}

describe('what a failed workspace read is reported as', () => {
  it('says the record is unreadable only when the store said so', async () => {
    const { reasons } = connectAgainst(
      new StoredDocumentUnreadableError('malformed', 'chunks do not match the manifest'),
    )
    await vi.waitFor(() => expect(reasons).toEqual(['corrupt-snapshot']))
  })

  it('reports a read that never completed as unavailable, not as damage', async () => {
    // The exact rejection `openWhiteboardDb` produces when another tab holds
    // an older version. Nothing is known about the stored document here.
    const { reasons } = connectAgainst(
      new Error('another tab has this app open at an older version; close it and reload'),
    )
    await vi.waitFor(() => expect(reasons).toEqual(['read-unavailable']))
  })

  it('treats an aborted IndexedDB transaction the same way', async () => {
    // The shape a transaction abort arrives in. Grouped with the case above
    // rather than listed as its own rule: what makes both storage failures is
    // that neither says anything about the bytes.
    const { reasons } = connectAgainst(new DOMException('transaction aborted', 'AbortError'))
    await vi.waitFor(() => expect(reasons).toEqual(['read-unavailable']))
  })
})
