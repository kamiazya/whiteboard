import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseDaemonSubcommandArgs } from '../../src/cli/argv.js'
import { repoRoot } from '../../src/shared/test-utils/repo-root.js'
import {
  buildMcpHttpDevSpawnArgs,
  DEFAULT_READY_TIMEOUT_MS,
  describeTokenConflict,
  refusalLine,
  resolveDevBearerToken,
  resolveReadyTimeoutMs,
  waitForDaemon,
} from './ensure-http-dev-daemon-lib.mjs'

describe('HTTP dev daemon startup', () => {
  it('uses the current Codex hooks feature flag', async () => {
    const config = await readFile(join(repoRoot(), '.codex/config.toml'), 'utf8')

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

describe('waitForDaemon gives up', () => {
  it('stops polling as soon as `gaveUp` holds, without waiting out the timeout', async () => {
    const probe = vi.fn().mockResolvedValue(false)
    let polls = 0
    const result = await waitForDaemon({
      isUp: probe,
      sleep: async () => {
        polls += 1
        if (polls > 50) throw new Error('kept polling after it gave up')
      },
      timeoutMs: 1_000_000,
      pollIntervalMs: 10,
      gaveUp: () => polls >= 2,
      now: () => 0,
    })
    expect(result).toBe(false)
    expect(probe).toHaveBeenCalledTimes(3)
  })
})

// The SessionStart hook prints why the dev server it started exited, rather
// than pointing at a log: this is what `pnpm mcp:http:dev` writes there when
// it refuses (captured from a real run), pnpm's own report included.
describe('refusalLine', () => {
  it("picks the dev server's own last line out of pnpm's report around it", () => {
    const log = [
      '[WARN] Unsupported engine: wanted: {"node":"^24"} (current: {"node":"v22.22.0","pnpm":"11.12.0"})',
      '$ pnpm --filter @kamiazya/whiteboard-mcp mcp:http:dev',
      '.                                        | [WARN] Unsupported engine: wanted: {"node":"^24"} (current: {"node":"v22.22.0","pnpm":"11.12.0"})',
      '$ node scripts/dev/with-dev-data-dir.mjs --token=whiteboard-dev --idle-timeout-ms=0',
      '[with-dev-data-dir] failed to spawn dev server: spawn ENOENT',
      '/home/user/whiteboard/packages/mcp-server:',
      '[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @kamiazya/whiteboard-mcp@0.0.20 mcp:http:dev: `node scripts/dev/with-dev-data-dir.mjs --token=whiteboard-dev --idle-timeout-ms=0`',
      'Exit status 1',
      '[ELIFECYCLE] Command failed with exit code 1.',
      '',
    ].join('\n')
    expect(refusalLine(log)).toBe('[with-dev-data-dir] failed to spawn dev server: spawn ENOENT')
  })

  it("picks a crash's error line out of the source excerpt, stack and dump around it", () => {
    const log = [
      'node:net:1918',
      "      const error = new UVExceptionWithHostPort(rval, 'listen', address, port);",
      '                    ^',
      '',
      'Error: listen EADDRINUSE: address already in use /repo/.dev-data/daemon.sock',
      '    at Server.setupListenHandle [as _listen2] (node:net:1918:21)',
      '    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5) {',
      "  code: 'EADDRINUSE',",
      '  port: -1',
      '}',
      '',
      'Node.js v22.22.0',
      'Exit status 1',
    ].join('\n')
    expect(refusalLine(log)).toBe(
      'Error: listen EADDRINUSE: address already in use /repo/.dev-data/daemon.sock',
    )
  })

  it('answers null when the dev server said nothing of its own', () => {
    expect(refusalLine('Exit status 1\n[ELIFECYCLE] Command failed with exit code 1.\n')).toBeNull()
    expect(refusalLine('')).toBeNull()
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

describe('the token-conflict remedy', () => {
  it('names a CLI command the CLI accepts as typed, with the checkout data dir', () => {
    const message = describeTokenConflict({ pid: 4242, dataDir: '/work/repo/.dev-data' })
    const typed = /`whiteboard daemon (stop[^`]*)`/.exec(message)?.[1]
    expect(typed, message).toBeDefined()

    const [subcommand, ...rest] = (typed as string).split(/\s+/)
    expect(subcommand).toBe('stop')
    expect(parseDaemonSubcommandArgs(rest as string[], 'daemon stop')).toEqual({
      kind: 'ok',
      json: true,
      dataDir: '/work/repo/.dev-data',
    })
  })

  it('names the per-checkout stop script, which exists', async () => {
    const message = describeTokenConflict({ pid: 1, dataDir: '/d' })
    expect(message).toContain('pnpm mcp:http:stop')
    const manifest = JSON.parse(
      await readFile(join(repoRoot(), 'packages/mcp-server/package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(manifest.scripts['mcp:http:stop']).toBeDefined()
  })
})
