// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { DaemonContractError } from './daemon-contract-error.js'
import { createDaemonVersionsBackend, VersionsRequestError } from './versions-backend.js'

const backendAnswering = (response: Response) =>
  createDaemonVersionsBackend(vi.fn().mockResolvedValue(response))

const contractFailure = (attempt: Promise<unknown>) => attempt.catch((err: unknown) => err)

describe('the daemon versions backend, answered with a body its contract refuses', () => {
  it('throws a DaemonContractError from list, naming the route and the first issue path', async () => {
    const backend = backendAnswering(jsonResponse({ versions: [{ id: 1 }] }))

    const failure = await contractFailure(backend.list('ws', 'notes/a'))

    expect(failure).toBeInstanceOf(DaemonContractError)
    expect((failure as DaemonContractError).route).toContain('/versions')
    expect((failure as DaemonContractError).issues[0]?.path.slice(0, 2)).toEqual(['versions', 0])
    await expectLoggedFailure('/versions failed its contract at versions.0.id')
  })

  it('throws a DaemonContractError from loadPast, naming the first issue path', async () => {
    const backend = backendAnswering(jsonResponse({ kind: 'spatial' }))

    const failure = await contractFailure(backend.loadPast('ws', 'notes/a', 'v1'))

    expect(failure).toBeInstanceOf(DaemonContractError)
    expect((failure as DaemonContractError).issues[0]?.path).toEqual(['canvas'])
    await expectLoggedFailure('failed its contract at canvas')
  })

  it('throws a DaemonContractError from save, which the old wording never matched', async () => {
    const backend = backendAnswering(jsonResponse({ nope: true }))

    const failure = await contractFailure(backend.save('ws', 'notes/a', { label: 'x' }))

    expect(failure).toBeInstanceOf(DaemonContractError)
    expect((failure as DaemonContractError).issues[0]?.path).toEqual(['version'])
    await expectLoggedFailure('/versions failed its contract at version')
  })
})

describe('the daemon versions backend, answered with a body that is not JSON', () => {
  it.each([
    ['list', (backend: ReturnType<typeof backendAnswering>) => backend.list('ws', 'notes/a')],
    [
      'loadPast',
      (backend: ReturnType<typeof backendAnswering>) => backend.loadPast('ws', 'notes/a', 'v1'),
    ],
  ])('reads it from %s as contract drift, not an untyped parse error', async (_, call) => {
    const failure = await contractFailure(call(backendAnswering(new Response('<html>'))))

    expect(failure).toBeInstanceOf(DaemonContractError)
    await expectLoggedFailure('failed its contract at (root)')
  })
})

describe('the daemon versions backend, refused', () => {
  it('rejects a restore whose refusal is cut mid-body as the network, carrying no keeper reason', async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":'))
        controller.error(new TypeError('network error'))
      },
    })
    const backend = backendAnswering(new Response(cut, { status: 409 }))
    await expect(backend.restore('ws', 'notes/a', 'v1')).rejects.toMatchObject({
      name: 'FetchFailedError',
    })
  })
})

describe('the daemon versions backend, paging a long history', () => {
  const row = (id: string) => ({
    id,
    path: 'notes/a',
    createdAt: '2026-01-01T00:00:00.000Z',
    elementCount: 0,
    auto: false,
  })

  it('reads every page of a list, handing each cursor back', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ versions: [row('v3'), row('v2')], nextCursor: '9.2' }))
      .mockResolvedValueOnce(jsonResponse({ versions: [row('v1')] }))
    const backend = createDaemonVersionsBackend(fetchFn)

    const versions = await backend.list('ws', 'notes/a')

    expect(versions.map((v) => v.id)).toEqual(['v3', 'v2', 'v1'])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(String(fetchFn.mock.calls[1]?.[0])).toMatch(/\/versions\?cursor=9\.2$/)
  })

  it('carries the daemon\u2019s reason when a save is refused past the version ceiling', async () => {
    const backend = backendAnswering(
      jsonResponse(
        { error: 'too_many_versions', message: 'This document already keeps 200 saved versions' },
        413,
      ),
    )

    const failure = await contractFailure(backend.save('ws', 'notes/a', { label: 'x' }))

    expect(failure).toBeInstanceOf(VersionsRequestError)
    expect(failure).toMatchObject({
      status: 413,
      reason: 'This document already keeps 200 saved versions',
    })
  })
})
