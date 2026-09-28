import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildMcpHttpDevSpawnArgs,
  DEFAULT_READY_TIMEOUT_MS,
  resolveDevBearerToken,
  resolveReadyTimeoutMs,
  waitForDaemon,
} from './ensure-http-dev-daemon-lib.mjs'

describe('HTTP dev daemon startup', () => {
  it('uses the current Codex hooks feature flag', async () => {
    // .codex/config.toml lives at the repo root (../../../../ from packages/mcp-server/scripts/dev).
    const config = await readFile(
      resolve(import.meta.dirname, '../../../../.codex/config.toml'),
      'utf8',
    )

    expect(config).toMatch(/^\s*hooks\s*=\s*true\s*$/m)
    expect(config).not.toMatch(/^\s*codex_hooks\s*=/m)
  })

  it('polls until the daemon is up', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const sleep = vi.fn().mockResolvedValue(undefined)

    const result = await waitForDaemon({
      isUp: probe,
      sleep,
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(10),
    })

    expect(result).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(10)
  })

  it('returns false when the timeout elapses before the daemon is up', async () => {
    // Simulate a clock that jumps past the timeout on the second now() call,
    // so the while-loop guard fails before the probe can answer.
    const probe = vi.fn().mockResolvedValue(false)
    const sleep = vi.fn().mockResolvedValue(undefined)

    const result = await waitForDaemon({
      isUp: probe,
      sleep,
      timeoutMs: 500,
      pollIntervalMs: 10,
      now: vi
        .fn()
        .mockReturnValueOnce(0) // startedAt
        .mockReturnValueOnce(600), // first loop check: 600 >= 500, exits immediately
    })

    expect(result).toBe(false)
    // The loop exits before any probe fires because now()-startedAt >= timeoutMs
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('resolveDevBearerToken', () => {
  it('returns the env var value when WHITEBOARD_TOKEN is set', () => {
    expect(resolveDevBearerToken({ WHITEBOARD_TOKEN: 'my-custom-token' })).toBe('my-custom-token')
  })

  it('returns the hardcoded default when WHITEBOARD_TOKEN is absent', () => {
    expect(resolveDevBearerToken({})).toBe('whiteboard-dev')
  })

  it('returns the hardcoded default when WHITEBOARD_TOKEN is undefined', () => {
    expect(resolveDevBearerToken({ WHITEBOARD_TOKEN: undefined })).toBe('whiteboard-dev')
  })
})

describe('buildMcpHttpDevSpawnArgs', () => {
  it('injects --token when token differs from the package-script default', () => {
    const args = buildMcpHttpDevSpawnArgs('my-custom-token')
    expect(args).toContain('--token=my-custom-token')
  })

  it('does NOT inject --token when token is the package-script default', () => {
    // pnpm mcp:http:dev already passes --token=whiteboard-dev; no duplication needed
    const args = buildMcpHttpDevSpawnArgs('whiteboard-dev')
    expect(args.some((a) => a.startsWith('--token='))).toBe(false)
  })

  // The daemon listens on its data dir's socket and no TCP port (ADR-0050).
  it('hands the spawned daemon no port', () => {
    const args = buildMcpHttpDevSpawnArgs('whiteboard-dev')
    expect(args.some((a) => a.startsWith('--port'))).toBe(false)
  })
})

describe('resolveReadyTimeoutMs', () => {
  it('defaults to DEFAULT_READY_TIMEOUT_MS when the override is absent', () => {
    expect(resolveReadyTimeoutMs({})).toBe(DEFAULT_READY_TIMEOUT_MS)
  })

  it('defaults when the override is undefined', () => {
    expect(resolveReadyTimeoutMs({ WHITEBOARD_DEV_READY_TIMEOUT_MS: undefined })).toBe(
      DEFAULT_READY_TIMEOUT_MS,
    )
  })

  it('uses a valid positive integer override', () => {
    expect(resolveReadyTimeoutMs({ WHITEBOARD_DEV_READY_TIMEOUT_MS: '5000' })).toBe(5000)
  })

  it.each([
    '',
    'abc',
    '0',
    '-1',
    '1.5',
    'Infinity',
    'NaN',
  ])('falls back to the default for a malformed override %j (never throws)', (raw) => {
    expect(resolveReadyTimeoutMs({ WHITEBOARD_DEV_READY_TIMEOUT_MS: raw })).toBe(
      DEFAULT_READY_TIMEOUT_MS,
    )
  })
})
