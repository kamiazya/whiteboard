import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { waitForAuthenticatedMcp } from './ensure-http-dev-daemon-lib.mjs'

describe('HTTP dev daemon startup', () => {
  it('uses the current Codex hooks feature flag', async () => {
    // .codex/config.toml lives at the repo root (../../../ from packages/mcp-server/scripts).
    const config = await readFile(resolve(import.meta.dirname, '../../../.codex/config.toml'), 'utf8')

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
})
