import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import {
  DAEMON_CONTRACT_COPY,
  DaemonContractError,
  readDaemonJson,
  reportDaemonDrift,
} from './daemon-contract-error.js'

const schema = z.object({ versions: z.array(z.object({ id: z.string() })) })

/** What reading `input` as a daemon answer threw, which must fail the schema. */
async function failureOf(route: string, input: unknown): Promise<DaemonContractError> {
  const failure = await readDaemonJson(route, jsonResponse(input), schema).then(
    () => new Error('fixture must not parse'),
    (err: unknown) => err,
  )
  if (failure instanceof DaemonContractError) return failure
  throw failure
}

describe('a contract mismatch', () => {
  it('carries the route and the issues, and tells the person one generic sentence', async () => {
    const error = await failureOf('/api/v1/versions', { versions: [{ id: 7 }] })

    expect(error.route).toBe('/api/v1/versions')
    expect(error.issues[0]?.path).toEqual(['versions', 0, 'id'])
    expect(error.message).toBe(DAEMON_CONTRACT_COPY)
    expect(error.message).not.toContain('versions')
    await expectLoggedFailure('/api/v1/versions failed its contract')
  })

  it('logs the route and the first issue path as it builds the error', async () => {
    await failureOf('/api/v1/versions', { versions: [{ id: 7 }] })

    await expectLoggedFailure('/api/v1/versions failed its contract at versions.0.id')
  })

  it('names a root-level mismatch', async () => {
    await failureOf('/api/v1/x', 'nope')

    await expectLoggedFailure('/api/v1/x failed its contract at (root)')
  })
})

describe('reportDaemonDrift', () => {
  // The seam a caller uses when drift is an arm of its own result rather than
  // a throw: nothing downstream logs it, so this record is the only one.
  it('logs the route and the first issue path of a mismatch nobody throws', async () => {
    const parsed = schema.safeParse({ versions: [{ id: 7 }] })
    if (parsed.success) throw new Error('fixture must not parse')

    reportDaemonDrift('/api/workspaces/w/replica-key', parsed.error)

    await expectLoggedFailure('/api/workspaces/w/replica-key failed its contract at versions.0.id')
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
