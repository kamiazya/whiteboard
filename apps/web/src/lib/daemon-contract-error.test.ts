import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import {
  DAEMON_CONTRACT_COPY,
  DaemonContractError,
  daemonContractError,
  logDaemonContractError,
} from './daemon-contract-error.js'

const schema = z.object({ versions: z.array(z.object({ id: z.string() })) })

function failureOf(input: unknown): z.ZodError {
  const parsed = schema.safeParse(input)
  if (parsed.success) throw new Error('fixture must not parse')
  return parsed.error
}

describe('daemonContractError', () => {
  it('carries the route and the issues, and tells the person one generic sentence', () => {
    const zodError = failureOf({ versions: [{ id: 7 }] })

    const error = daemonContractError('/api/v1/versions', zodError)

    expect(error).toBeInstanceOf(DaemonContractError)
    expect(error.route).toBe('/api/v1/versions')
    expect(error.issues).toEqual(zodError.issues)
    expect(error.message).toBe(DAEMON_CONTRACT_COPY)
    expect(error.message).not.toContain('versions')
  })
})

describe('logDaemonContractError', () => {
  it('logs the route and the first issue path', async () => {
    logDaemonContractError(
      daemonContractError('/api/v1/versions', failureOf({ versions: [{ id: 7 }] })),
    )

    await expectLoggedFailure('/api/v1/versions failed its contract at versions.0.id')
  })

  it('names a root-level mismatch', async () => {
    logDaemonContractError(daemonContractError('/api/v1/x', failureOf('nope')))

    await expectLoggedFailure('/api/v1/x failed its contract at (root)')
  })
})
