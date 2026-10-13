/**
 * An embedded note in a daemon-kept markdown preview is titled from the
 * page's document list. The daemon's snapshot carries no display name — a
 * document's name is the workspace's (ADR-0009 decision 2) — so the list
 * the page already holds is the only place the embed's title can come from.
 * The editor is a stub that records the reference seams it is handed, since
 * the subject is the page wiring, not the preview's drawing.
 */

import type { ReferenceSeams } from '@kamiazya/whiteboard-canvas-render'
import {
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { FakeDocumentBackend, renderInRouter } from '../test-utils/daemon-page-harness.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'createDocument',
  ]),
)

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const captured = vi.hoisted(() => ({ references: [] as unknown[] }))

vi.mock('../components/markdown-editor/MarkdownEditor.js', () => ({
  MarkdownEditor: (props: { references?: unknown }) => {
    captured.references.push(props.references)
    return <div data-testid="markdown-source-stub" />
  },
}))

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'
const OTHER_ID = 'id-other'
const LINKED_ID = 'id-linked'

function markdownSnapshot(body: string): Uint8Array {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, body)
  writeCoreFacets(doc, { type: 'markdown' })
  writeDocumentKind(doc, 'markdown')
  return doc.export({ mode: 'snapshot' })
}

function latestReferences(): ReferenceSeams | undefined {
  return captured.references.at(-1) as ReferenceSeams | undefined
}

describe('DaemonDocumentPage embedded note title', () => {
  beforeEach(() => {
    captured.references.length = 0
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'host', documentId: 'id-host', updatedAt: '2026-01-01', kind: 'markdown' },
        {
          path: 'notes/other',
          documentId: OTHER_ID,
          name: 'Other note',
          updatedAt: '2026-01-01',
          kind: 'markdown',
        },
        { path: 'notes/linked', documentId: LINKED_ID, updatedAt: '2026-01-01', kind: 'markdown' },
      ],
    })
    // The embed's content comes off the daemon's snapshot route, nameless.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/names')) return jsonResponse({ documents: {}, pinned: [] })
        if (url.includes('other') && url.endsWith('/snapshot')) {
          return new Response(markdownSnapshot('embedded prose') as BodyInit)
        }
        return jsonResponse({}, 404)
      }),
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it("titles a `![[path]]` embed from the page's list, which the snapshot cannot name", async () => {
    renderInRouter(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId="w1"
        path="host"
        createBackend={() =>
          new FakeDocumentBackend(() =>
            markdownSnapshot('see [[notes/linked]]\n\n![[notes/other]]\n'),
          )
        }
      />,
    )

    await waitFor(
      () => {
        expect(latestReferences()?.resolveEmbed(OTHER_ID)?.title).toBe('Other note')
      },
      { timeout: 10_000 },
    )
    expect(JSON.stringify(latestReferences()?.resolveEmbed(OTHER_ID))).toContain('embedded prose')
    expect(latestReferences()?.resolveAlias('notes/other')).toBe(OTHER_ID)
  })

  it('resolves a `[[path]]` link through the list when no load answered it', async () => {
    renderInRouter(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId="w1"
        path="host"
        createBackend={() =>
          new FakeDocumentBackend(() =>
            markdownSnapshot('see [[notes/linked]]\n\n![[notes/other]]\n'),
          )
        }
      />,
    )

    // The embed landing is what says the prefetch has run; the linked
    // document's snapshot route answers 404, so only the list knows it.
    await waitFor(
      () => {
        expect(latestReferences()?.resolveEmbed(OTHER_ID)).toBeDefined()
      },
      { timeout: 10_000 },
    )
    expect(latestReferences()?.resolveAlias('notes/linked')).toBe(LINKED_ID)
  })

  it('asks again when the keeper was busy, and draws the embed once it answers', async () => {
    // A 503 is the daemon's "database busy", not "no such document": the
    // body's loader must reject so the prefetch retries, rather than answer
    // the terminal `undefined` that leaves the embed blank for the page's life.
    let busy = true
    const snapshotReads = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/names')) return jsonResponse({ documents: {}, pinned: [] })
        if (url.includes('other') && url.endsWith('/snapshot')) {
          snapshotReads()
          if (busy) {
            busy = false
            return jsonResponse({ error: 'database_busy', message: 'busy' }, 503)
          }
          return new Response(markdownSnapshot('embedded prose') as BodyInit)
        }
        return jsonResponse({}, 404)
      }),
    )
    renderInRouter(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId="w1"
        path="host"
        createBackend={() => new FakeDocumentBackend(() => markdownSnapshot('![[notes/other]]\n'))}
      />,
    )

    await waitFor(
      () => {
        expect(JSON.stringify(latestReferences()?.resolveEmbed(OTHER_ID))).toContain(
          'embedded prose',
        )
      },
      { timeout: 10_000 },
    )
    expect(snapshotReads).toHaveBeenCalledTimes(2)
    await expectLoggedFailure('referenced document load failed')
    await expectLoggedFailure('reference load failed')
  })
})
