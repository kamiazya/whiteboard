import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebOriginTrustStore } from '../server/security/web-origin-trust-store.js'
import { runTrustCommand } from './trust.js'

describe('whiteboard trust CLI', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-trust-cli-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('list prints "no trusted origins" for an empty store', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    const result = await runTrustCommand(['list'], store)
    expect(result).toEqual({ exitCode: 0, output: 'no trusted origins' })
  })

  it('list prints each trusted origin with its last-used timestamp', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    await store.trustOrigin('http://localhost:5173')

    const result = await runTrustCommand(['list'], store)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('http://localhost:5173')
    expect(result.output).toContain('last used')
  })

  it('revoke <origin> removes exactly that origin and mutates the on-disk store', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    await store.trustOrigin('http://localhost:5173')
    await store.trustOrigin('http://localhost:6000')

    const result = await runTrustCommand(['revoke', 'http://localhost:5173'], store)
    expect(result).toEqual({ exitCode: 0, output: 'revoked http://localhost:5173' })

    const remaining = await store.list()
    expect(remaining.map((r) => r.origin)).toEqual(['http://localhost:6000'])
  })

  it('revoke <unknown-origin> exits non-zero with a message', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    const result = await runTrustCommand(['revoke', 'http://never-trusted.invalid'], store)
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('http://never-trusted.invalid')
  })

  it('revoke --all empties the store', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    await store.trustOrigin('http://localhost:5173')
    await store.trustOrigin('http://localhost:6000')

    const result = await runTrustCommand(['revoke', '--all'], store)
    expect(result.exitCode).toBe(0)
    expect(await store.list()).toEqual([])
  })

  it('an unrecognized command exits non-zero with usage', async () => {
    const store = createWebOriginTrustStore({ dataDir })
    const result = await runTrustCommand([], store)
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('usage')
  })
})
