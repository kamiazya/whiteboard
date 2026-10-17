// @vitest-environment jsdom
/**
 * The handshake's two guards that the page's own controls keep out of reach:
 * an accept before anything was offered, and a success reported to a window
 * that has no opener. The page disables its button until an offer arrives and
 * is normally opened by the sender, so neither is driven by a page test.
 */
import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import { base64UrlToBytes } from '@kamiazya/whiteboard-model'
import { act, renderHook, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import {
  CROSS_ORIGIN_TRANSFER_PROTOCOL,
  transferResponseSchema,
} from '../lib/cross-origin-transfer-protocol.js'
import { useTransferHandshake } from './use-transfer-handshake.js'

const SENDER = 'https://app.example'
const NONCE = 'n'.repeat(32)
const HASH = `#${new URLSearchParams({ from: SENDER, nonce: NONCE })}`

function senderSnapshot(): Uint8Array {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: 'notes/roadmap',
    documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    kind: 'markdown',
  })
  return new Uint8Array(record.export({ mode: 'snapshot' }))
}

/** A keeper holding one workspace, whose promote imports into `target`. */
function keeper(target: LoroDoc) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/api/workspaces')) {
      return Response.json({ workspaces: [{ workspaceId: 'ws-here' }] })
    }
    if (url.endsWith('/workspace-document/promote') && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { snapshot: string }
      target.import(base64UrlToBytes(body.snapshot) as Uint8Array)
      return Response.json({
        ok: true,
        recorded: readWorkspaceDocuments(target).map((entry) => entry.documentId),
        shadowed: [],
      })
    }
    if (url.endsWith('/documents')) {
      const documents = readWorkspaceDocuments(target).map((entry) => ({
        path: entry.path,
        documentId: entry.documentId,
        kind: entry.kind,
        updatedAt: new Date().toISOString(),
      }))
      return Response.json({ documents })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

function offerArrives(): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: SENDER,
      data: {
        type: 'transfer-offer',
        protocol: CROSS_ORIGIN_TRANSFER_PROTOCOL,
        nonce: NONCE,
        snapshot: senderSnapshot(),
        documentCount: 1,
        sourceWorkspaceId: 'ws-sender',
      },
    }),
  )
}

describe('useTransferHandshake', () => {
  it('does nothing when accepted before any offer arrived', async () => {
    const fetchFn = keeper(new LoroDoc())
    const { result } = renderHook(() =>
      useTransferHandshake({ hash: HASH, fetchFn, opener: { postMessage: vi.fn() } }),
    )
    await waitFor(() => expect(result.current.targets).toHaveLength(1))
    act(() => result.current.setTargetId('ws-here'))

    await act(() => result.current.accept())

    expect(result.current.stage).toEqual({ kind: 'waiting' })
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual(['/api/workspaces'])
  })

  it('finishes a merge in a window that has no opener to report to', async () => {
    const target = new LoroDoc()
    const { result } = renderHook(() =>
      useTransferHandshake({ hash: HASH, fetchFn: keeper(target), opener: null }),
    )
    await waitFor(() => expect(result.current.targets).toHaveLength(1))
    act(() => offerArrives())
    await waitFor(() => expect(result.current.stage.kind).toBe('confirming'))
    act(() => result.current.confirm())
    act(() => result.current.setTargetId('ws-here'))

    // Awaited through the stage: `await act(accept)` never settled on this
    // path under jsdom. The promise is then held to resolving, not rejecting.
    const accepted = result.current.accept()
    await waitFor(() => expect(result.current.stage.kind).toBe('done'))
    await expect(accepted).resolves.toBeUndefined()

    expect(result.current.stage).toMatchObject({ kind: 'done', documentCount: 1 })
    expect(readWorkspaceDocuments(target).map((entry) => entry.path)).toEqual(['notes/roadmap'])
  })

  it('asks first: an offer is not acceptable until the person confirms they started it', async () => {
    const fetchFn = keeper(new LoroDoc())
    const opener = { postMessage: vi.fn() }
    const { result } = renderHook(() => useTransferHandshake({ hash: HASH, fetchFn, opener }))
    await waitFor(() => expect(result.current.targets).toHaveLength(1))
    act(() => offerArrives())
    await waitFor(() => expect(result.current.stage.kind).toBe('confirming'))
    act(() => result.current.setTargetId('ws-here'))

    await act(() => result.current.accept())

    expect(result.current.stage.kind).toBe('confirming')
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual(['/api/workspaces'])
    // Only the ready handshake has gone back to the opener.
    expect(opener.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      'transfer-ready',
    ])
  })

  it('preselects no target even when the keeper lists exactly one workspace', async () => {
    const fetchFn = keeper(new LoroDoc())
    const { result } = renderHook(() => useTransferHandshake({ hash: HASH, fetchFn, opener: null }))
    await waitFor(() => expect(result.current.targets).toHaveLength(1))
    act(() => offerArrives())
    await waitFor(() => expect(result.current.stage.kind).toBe('confirming'))
    act(() => result.current.confirm())

    expect(result.current.stage.kind).toBe('offered')
    expect(result.current.targetId).toBe('')
    await act(() => result.current.accept())
    expect(result.current.stage.kind).toBe('offered')
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual(['/api/workspaces'])
  })

  it('declining posts only a decline to the opener and merges nothing', async () => {
    const target = new LoroDoc()
    const fetchFn = keeper(target)
    const opener = { postMessage: vi.fn() }
    const { result } = renderHook(() => useTransferHandshake({ hash: HASH, fetchFn, opener }))
    await waitFor(() => expect(result.current.targets).toHaveLength(1))
    act(() => offerArrives())
    await waitFor(() => expect(result.current.stage.kind).toBe('confirming'))

    act(() => result.current.decline())

    expect(result.current.stage).toEqual({ kind: 'declined' })
    const [ready, decline, ...rest] = opener.postMessage.mock.calls
    expect(rest).toEqual([])
    expect(ready?.[0].type).toBe('transfer-ready')
    expect(decline?.[1]).toBe(SENDER)
    expect(transferResponseSchema.parse(decline?.[0])).toEqual({
      type: 'transfer-result',
      nonce: NONCE,
      ok: false,
      declined: true,
      reason: expect.any(String),
    })
    // A later offer on the same attempt is not asked about again.
    act(() => offerArrives())
    expect(result.current.stage).toEqual({ kind: 'declined' })
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual(['/api/workspaces'])
    expect(readWorkspaceDocuments(target)).toEqual([])
  })
})
