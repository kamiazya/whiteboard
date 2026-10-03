// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { DaemonContractError } from './daemon-contract-error.js'
import { createDaemonVersionsBackend } from './versions-backend.js'

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
