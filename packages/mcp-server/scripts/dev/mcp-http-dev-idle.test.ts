import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { IdleTimer } from '../../src/daemon/idle-timer.js'

// The dev daemon (`pnpm mcp:http:dev`) previously inherited the packaged
// server's 15-minute idle-shutdown default with no override, so a dev
// session idle for 15+ minutes silently closed its own listener — the
// SessionStart hook only runs once, so nothing re-spawned it and the
// integrator session lost its MCP tools with no error at all. This test
// reads the *actual* shipped `mcp:http:dev` script argv (not a hand-copied
// literal) so a future edit that drops the override is caught here, not in
// a 15-minute-later outage.
const PACKAGE_JSON_PATH = resolve(import.meta.dirname, '../../package.json')

async function readIdleTimeoutMsFromDevScript(): Promise<number> {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8'))
  const script: string = pkg.scripts['mcp:http:dev']
  const match = script.match(/--idle-timeout-ms=(\S+)/)
  // Mirrors the server's own fallback (src/server/index.ts readArg default)
  // when the dev script passes no override at all.
  return match ? Number(match[1]) : 15 * 60_000
}

describe('mcp:http:dev idle-timeout wiring', () => {
  it('never idles out the dev daemon under the shipped argv', async () => {
    const idleTimeoutMs = await readIdleTimeoutMsFromDevScript()

    vi.useFakeTimers()
    const onIdle = vi.fn()
    const timer = new IdleTimer(idleTimeoutMs, onIdle)
    timer.start()

    // Well past the packaged 15-minute default this script used to inherit.
    vi.advanceTimersByTime(60 * 60_000)
    expect(onIdle).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
