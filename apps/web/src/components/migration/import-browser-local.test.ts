import { Loro } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import type { LoroLoadResult } from '../../lib/loro-store.js'
import { importOneDocument, mergeToSnapshot } from './import-browser-local.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('mergeToSnapshot', () => {
  it('imports a snapshot and deltas into one combined snapshot', () => {
    const base = new Loro()
    base.getMovableList('elements').push('a')
    base.commit()
    const snapshot = base.export({ mode: 'snapshot' })
    const prevVV = base.version()

    base.getMovableList('elements').push('b')
    base.commit()
    const delta = base.export({ mode: 'update', from: prevVV })

    const merged = mergeToSnapshot(snapshot, [delta])

    const reimported = new Loro()
    reimported.import(merged)
    expect(reimported.getMovableList('elements').toJSON()).toEqual(['a', 'b'])
  })

  it('returns the snapshot unchanged (re-importable) when there are no deltas', () => {
    const base = new Loro()
    base.getMovableList('elements').push('solo')
    base.commit()
    const snapshot = base.export({ mode: 'snapshot' })

    const merged = mergeToSnapshot(snapshot, [])
    const reimported = new Loro()
    reimported.import(merged)
    expect(reimported.getMovableList('elements').toJSON()).toEqual(['solo'])
  })
})

function loroOkResult(): LoroLoadResult {
  const doc = new Loro()
  doc.getMovableList('elements').push('x')
  doc.commit()
  return { kind: 'ok', snapshot: doc.export({ mode: 'snapshot' }) }
}

describe('importOneDocument', () => {
  it('creates the canvas and pushes the merged snapshot via the injected fetch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ path: 'my-canvas' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))

    // workspaceId deliberately needs percent-encoding: the shared api-contracts
    // type it as an unconstrained string, so URL construction must encode it
    // exactly like daemon-api-client.ts does for the same routes.
    const result = await importOneDocument({
      fetch: fetchMock,
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws 1#x',
      documentPath: 'my-canvas',
      documentKind: 'markdown',
      loroLoad: loroOkResult(),
    })

    expect(result).toEqual({ kind: 'ok', path: 'my-canvas' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const encodedWs = encodeURIComponent('ws 1#x')
    const [createUrl, createInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(createUrl).toBe(`http://127.0.0.1:3099/api/workspaces/${encodedWs}/documents`)
    // The created canvas's kind must match the source browser-local
    // snapshot's kind — a markdown canvas migrated with a defaulted
    // 'spatial' kind opens in the wrong editor with no way to correct it.
    expect(JSON.parse(createInit.body as string)).toEqual({
      path: 'my-canvas',
      kind: 'markdown',
    })

    const [updateUrl, updateInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(updateUrl).toBe(`http://127.0.0.1:3099/api/w/${encodedWs}/document/my-canvas/update`)
    expect((updateInit.headers as Record<string, string>)['Content-Type']).toBe(
      'application/octet-stream',
    )
  })

  it('returns a structured failure instead of rejecting when fetch throws (daemon offline)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    const result = await importOneDocument({
      fetch: fetchMock,
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws1',
      documentPath: 'my-canvas',
      documentKind: 'spatial',
      loroLoad: loroOkResult(),
    })

    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.reason).toMatch(/daemon|network/i)
    }
  })

  it('retries with -2 then -3 suffixes on 409, bounded to 3 create attempts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ title: 'exists' }, 409))
      .mockResolvedValueOnce(jsonResponse({ title: 'exists' }, 409))
      .mockResolvedValueOnce(jsonResponse({ path: 'my-canvas-3' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))

    const result = await importOneDocument({
      fetch: fetchMock,
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws1',
      documentPath: 'my-canvas',
      documentKind: 'spatial',
      loroLoad: loroOkResult(),
    })

    expect(result).toEqual({ kind: 'ok', path: 'my-canvas-3' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const paths = [0, 1, 2].map((i) => {
      const [, init] = fetchMock.mock.calls[i] as [string, RequestInit]
      return (JSON.parse(init.body as string) as { path: string }).path
    })
    expect(paths).toEqual(['my-canvas', 'my-canvas-2', 'my-canvas-3'])
  })

  it('reports a clean failure with zero update calls when all 3 create attempts 409', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ title: 'exists' }, 409))

    const result = await importOneDocument({
      fetch: fetchMock,
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws1',
      documentPath: 'my-canvas',
      documentKind: 'spatial',
      loroLoad: loroOkResult(),
    })

    expect(result.kind).toBe('failed')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports failure without throwing on a network error/500 during update', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ path: 'my-canvas' }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))

    const result = await importOneDocument({
      fetch: fetchMock,
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws1',
      documentPath: 'my-canvas',
      documentKind: 'spatial',
      loroLoad: loroOkResult(),
    })

    expect(result.kind).toBe('failed')
  })

  it('reports failure when the update response does not parse under updateDocumentResponseSchema', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ path: 'my-canvas' }))
      .mockResolvedValueOnce(jsonResponse({ ok: false }))

    const result = await importOneDocument({
      fetch: fetchMock,
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws1',
      documentPath: 'my-canvas',
      documentKind: 'spatial',
      loroLoad: loroOkResult(),
    })

    expect(result.kind).toBe('failed')
  })

  it.each([
    ['not-found', { kind: 'not-found' }] as const,
    ['corrupt-snapshot', { kind: 'corrupt-snapshot' }] as const,
    ['corrupt-delta', { kind: 'corrupt-delta' }] as const,
    ['unsupported-version', { kind: 'unsupported-version' }] as const,
  ])('reports a failure with zero daemon calls for LoroStore.load failure mode %s', async (_label, loroLoad) => {
    const fetchMock = vi.fn()

    const result = await importOneDocument({
      fetch: fetchMock,
      daemonBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws1',
      documentPath: 'my-canvas',
      documentKind: 'spatial',
      loroLoad: loroLoad as LoroLoadResult,
    })

    expect(result.kind).toBe('failed')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
