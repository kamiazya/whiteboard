import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import {
  DAEMON_CONTRACT_COPY,
  DaemonContractError,
  daemonContractError,
  parseDaemonResponse,
} from './daemon-contract-error.js'

const schema = z.object({ versions: z.array(z.object({ id: z.string() })) })

function failureOf(input: unknown): z.ZodError {
  const parsed = schema.safeParse(input)
  if (parsed.success) throw new Error('fixture must not parse')
  return parsed.error
}

describe('daemonContractError', () => {
  it('carries the route and the issues, and tells the person one generic sentence', async () => {
    const zodError = failureOf({ versions: [{ id: 7 }] })

    const error = daemonContractError('/api/v1/versions', zodError)

    expect(error).toBeInstanceOf(DaemonContractError)
    expect(error.route).toBe('/api/v1/versions')
    expect(error.issues).toEqual(zodError.issues)
    expect(error.message).toBe(DAEMON_CONTRACT_COPY)
    expect(error.message).not.toContain('versions')
    await expectLoggedFailure('/api/v1/versions failed its contract')
  })

  it('logs the route and the first issue path as it builds the error', async () => {
    daemonContractError('/api/v1/versions', failureOf({ versions: [{ id: 7 }] }))

    await expectLoggedFailure('/api/v1/versions failed its contract at versions.0.id')
  })

  it('names a root-level mismatch', async () => {
    daemonContractError('/api/v1/x', failureOf('nope'))

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
