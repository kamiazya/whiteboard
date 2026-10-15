/**
 * The offline banner says the daemon is away and edits ship when it returns.
 * When the native host refused the daemon record instead — another version's
 * daemon still running, a record this user cannot read — that daemon will not
 * "return" on its own, and the banner carries the record's own words for what
 * to do.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, render, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetShellStatusForTests } from '../lib/shell-status-store.js'
import { ReplicaReadPage } from './ReplicaReadPage.js'

const DAEMON_WS = '01ARZ3NDEKTSV4RRFFQ69G5FC0'
const DAEMON = 'http://127.0.0.1:3099'

const store = vi.hoisted(() => ({ record: null as import('loro-crdt').LoroDoc | null }))

vi.mock('../lib/browser-workspace-docs.js', () => ({
  BrowserWorkspaceDocs: class {
    open = async () => store.record
    save = async () => {}
  },
}))

function seedRecord(): LoroDoc {
  const record = new LoroDoc()
  const documentId = '01ARZ3NDEKTSV4RRFFQ69G5FC1'
  createWorkspaceDocumentAtPath(record, { path: 'plan', documentId, kind: 'markdown' })
  writeMarkdownBody(documentContainers(record, documentId), 'cached body')
  record.commit()
  return record
}

describe('ReplicaReadPage offline banner', () => {
  beforeEach(() => {
    store.record = seedRecord()
  })
  afterEach(() => {
    cleanup()
    resetShellStatusForTests()
  })

  it("carries the host's refusal after the offline sentence", async () => {
    const refusal = 'the daemon record /data/daemon.json names pid 7 of another version'
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        daemonBaseUrl={DAEMON}
        refusal={refusal}
        onReconnect={() => Promise.resolve()}
      />,
    )
    const banner = await screen.findByTestId('replica-offline-banner')
    expect(banner.textContent).toMatch(/unreachable/i)
    expect(banner.textContent).toContain(refusal)
  })

  it('says only the offline sentence when nothing was refused', async () => {
    render(
      <ReplicaReadPage
        workspaceId={DAEMON_WS}
        daemonBaseUrl={DAEMON}
        onReconnect={() => Promise.resolve()}
      />,
    )
    const banner = await screen.findByTestId('replica-offline-banner')
    expect(banner.textContent).toMatch(/ship to the daemon when it returns\.$/)
  })
})
