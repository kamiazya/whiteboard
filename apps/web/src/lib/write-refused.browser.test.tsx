/**
 * A note whose browser keeper refuses a change, end to end over the real
 * IndexedDB: the person is told why, the page goes back to what is stored,
 * and what they type afterwards is what a reload finds.
 *
 * Before this, every edit after a refused one imported into the record as
 * pending — changing nothing, saved anyway — while the page read saved, and
 * the reload lost the refused edit and everything after it.
 */
import { documentContainers, readMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WriteRefusedNotice } from '../components/connection/WriteRefusedNotice.js'
import { type UseDocumentSyncResult, useDocumentSync } from '../hooks/useDocumentSync.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { expectLoggedFailures } from '../test-utils/browser-setup.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BrowserBackend } from './browser-backend.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'

claimIsolatedWhiteboardDb('write-refused')

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const backend = () => new BrowserBackend({ documentId: ID, path: 'notes', kind: 'markdown' })

/** What a reload of the page would read. */
async function storedBody(): Promise<string> {
  const record = await new BrowserWorkspaceDocs().create(getBrowserWorkspaceId())
  return readMarkdownBody(documentContainers(record, ID))
}

function NotePage({
  sync,
  onSync,
}: {
  sync: BrowserBackend
  onSync: (r: UseDocumentSyncResult) => void
}) {
  onSync(useDocumentSync(sync, { contentDocumentId: ID }))
  return <WriteRefusedNotice />
}

beforeEach(clearWhiteboardDb)
afterEach(async () => {
  cleanup()
  await clearWhiteboardDb()
})

describe('a browser-kept note whose keeper refuses a change', () => {
  it('says why, shows what is stored, and keeps what is typed afterwards', async () => {
    let page = null as UseDocumentSyncResult | null
    render(<NotePage sync={backend()} onSync={(r) => (page = r)} />)
    const typed = (at: number, text: string) => {
      const binding = page?.bodyBinding
      if (!binding) throw new Error('the note has no body binding yet')
      binding.readText(binding.doc).insert(at, text)
      binding.commit()
    }
    await vi.waitFor(() => expect(page?.bodyBinding).toBeTruthy(), { timeout: 10_000 })
    typed(0, 'hello')
    await vi.waitFor(async () => expect(await storedBody()).toBe('hello'), { timeout: 10_000 })

    typed(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1))

    const notice = await screen.findByRole('alert', {}, { timeout: 10_000 })
    expect(notice.textContent).toContain('Your last change was not saved.')
    await vi.waitFor(() => expect(page?.markdownBody).toBe('hello'))
    typed(5, '!')
    await vi.waitFor(async () => expect(await storedBody()).toBe('hello!'), { timeout: 10_000 })
    await vi.waitFor(() => expect(page?.persistence.kind).toBe('saved'))
    expect(page?.markdownBody).toBe('hello!')
    expect(expectLoggedFailures().some((r) => r.includes('refused a body past'))).toBe(true)
  })
})
