import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import {
  DAEMON_CONTRACT_COPY,
  DaemonContractError,
  parseDaemonResponse,
  readDaemonJson,
} from './daemon-contract-error.js'

const schema = z.object({ versions: z.array(z.object({ id: z.string() })) })

/** What `parseDaemonResponse` threw for `input`, which must fail the schema. */
function failureOf(route: string, input: unknown): DaemonContractError {
  try {
    parseDaemonResponse(route, schema, input)
  } catch (err) {
    if (err instanceof DaemonContractError) return err
    throw err
  }
  throw new Error('fixture must not parse')
}

describe('a contract mismatch', () => {
  it('carries the route and the issues, and tells the person one generic sentence', async () => {
    const error = failureOf('/api/v1/versions', { versions: [{ id: 7 }] })

    expect(error.route).toBe('/api/v1/versions')
    expect(error.issues[0]?.path).toEqual(['versions', 0, 'id'])
    expect(error.message).toBe(DAEMON_CONTRACT_COPY)
    expect(error.message).not.toContain('versions')
    await expectLoggedFailure('/api/v1/versions failed its contract')
  })

  it('logs the route and the first issue path as it builds the error', async () => {
    failureOf('/api/v1/versions', { versions: [{ id: 7 }] })

    await expectLoggedFailure('/api/v1/versions failed its contract at versions.0.id')
  })

  it('names a root-level mismatch', async () => {
    failureOf('/api/v1/x', 'nope')

    await expectLoggedFailure('/api/v1/x failed its contract at (root)')
  })
})

describe('parseDaemonResponse', () => {
  it('returns the parsed answer without logging', () => {
    expect(parseDaemonResponse('/api/v1/x', schema, { versions: [{ id: 'a' }] })).toEqual({
      versions: [{ id: 'a' }],
    })
  })

  it('throws a DaemonContractError, so a swallowed read still leaves a record', async () => {
    const failure = (() => {
      try {
        return parseDaemonResponse('/api/v1/x', schema, { versions: 3 })
      } catch (err) {
        return err
      }
    })()

    expect(failure).toBeInstanceOf(DaemonContractError)
    await expectLoggedFailure('/api/v1/x failed its contract at versions')
  })
})

describe('readDaemonJson', () => {
  it('answers the parsed body of an answer that kept its contract', async () => {
    const res = jsonResponse({ versions: [{ id: 'a' }] })
    await expect(readDaemonJson('/api/v1/x', res, schema)).resolves.toEqual({
      versions: [{ id: 'a' }],
    })
  })

  it('reads an arrived body that is not JSON as contract drift, and reports it', async () => {
    const failure = await readDaemonJson('/api/v1/x', new Response('<html>'), schema).catch(
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(DaemonContractError)
    await expectLoggedFailure('/api/v1/x failed its contract at (root)')
  })

  it('reads a body cut mid-stream as the keeper not reached', async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"versions":['))
        controller.error(new TypeError('network error'))
      },
    })
    await expect(readDaemonJson('/api/v1/x', new Response(cut), schema)).rejects.toMatchObject({
      name: 'FetchFailedError',
    })
  })
})
