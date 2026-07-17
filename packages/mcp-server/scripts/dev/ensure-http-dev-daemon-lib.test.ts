import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildMcpHttpDevSpawnArgs,
  resolveDevBearerToken,
  verifyDevDaemonIdentity,
  waitForAuthenticatedMcp,
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

  it('waits until the daemon accepts an authenticated MCP initialize request', async () => {
    const probe = vi.fn().mockResolvedValueOnce('unreachable').mockResolvedValueOnce('ours')
    const sleep = vi.fn().mockResolvedValue(undefined)

    const result = await waitForAuthenticatedMcp({
      probe,
      sleep,
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(10),
    })

    expect(result).toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(10)
  })

  it('returns false when the timeout elapses before the daemon responds with "ours"', async () => {
    // Simulate a clock that jumps past the timeout on the second now() call,
    // so the while-loop guard fails before the probe can return 'ours'.
    const probe = vi.fn().mockResolvedValue('unreachable')
    const sleep = vi.fn().mockResolvedValue(undefined)

    const result = await waitForAuthenticatedMcp({
      probe,
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
    const args = buildMcpHttpDevSpawnArgs('my-custom-token', 3123)
    expect(args).toContain('--token=my-custom-token')
  })

  it('does NOT inject --token when token is the package-script default', () => {
    // pnpm mcp:http:dev already passes --token=whiteboard-dev; no duplication needed
    const args = buildMcpHttpDevSpawnArgs('whiteboard-dev', 3123)
    expect(args.some((a) => a.startsWith('--token='))).toBe(false)
  })

  it("appends --port=<derived> so the spawned daemon binds to this worktree's port", () => {
    const args = buildMcpHttpDevSpawnArgs('whiteboard-dev', 3123)
    expect(args).toContain('--port=3123')
  })
})

describe('verifyDevDaemonIdentity', () => {
  it('returns "foreign" when no marker exists for this data dir', () => {
    const verdict = verifyDevDaemonIdentity({
      marker: null,
      expectedPort: 3123,
      isPidAlive: () => true,
    })

    expect(verdict).toBe('foreign')
  })

  it('returns "foreign" when the marker records a different port (hash collision or stale)', () => {
    const verdict = verifyDevDaemonIdentity({
      marker: { port: 3099, repoRoot: '/other/repo', pid: 1, startedAt: '2026-01-01T00:00:00Z' },
      expectedPort: 3123,
      isPidAlive: () => true,
    })

    expect(verdict).toBe('foreign')
  })

  it('returns "stale" when the marker port matches but the recorded pid is dead', () => {
    const verdict = verifyDevDaemonIdentity({
      marker: { port: 3123, repoRoot: '/repo', pid: 999999, startedAt: '2026-01-01T00:00:00Z' },
      expectedPort: 3123,
      isPidAlive: () => false,
    })

    expect(verdict).toBe('stale')
  })

  it('returns "ours" when the marker port matches and the recorded pid is alive', () => {
    const verdict = verifyDevDaemonIdentity({
      marker: {
        port: 3123,
        repoRoot: '/repo',
        pid: process.pid,
        startedAt: '2026-01-01T00:00:00Z',
      },
      expectedPort: 3123,
      isPidAlive: () => true,
    })

    expect(verdict).toBe('ours')
  })
})
