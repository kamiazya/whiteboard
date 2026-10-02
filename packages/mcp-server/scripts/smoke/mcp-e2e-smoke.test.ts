import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('mcp-e2e-smoke.mjs', () => {
  // The smoke drives the server as a subprocess. A child that dies before it
  // answers must be reported as what it is — its own stderr — instead of
  // after the per-request timeout, which names the first request and not the
  // cause.
  it('reports a server that cannot start by its own error, without waiting out a request timeout', () => {
    const scriptPath = resolve(import.meta.dirname, 'mcp-e2e-smoke.mjs')

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--entry=/nonexistent/whiteboard-e2e-entry.mjs'],
      {
        // Long enough that a timeout path cannot finish inside the test's own
        // budget; the answer is read from the output, not from a stopwatch.
        env: { ...process.env, WHITEBOARD_SMOKE_RPC_TIMEOUT_MS: '60000' },
        encoding: 'utf8',
        timeout: 25_000,
      },
    )

    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    const output = `${result.stdout}${result.stderr}`
    expect(output).toContain('Cannot find module')
    expect(output).not.toContain('timed out')
  }, 30_000)
})
