import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { IdleTimer } from '../../src/daemon/idle-timer.js'

// The dev daemon must never idle out: nothing re-spawns it mid-session (the
// SessionStart hook fires once), so inheriting the packaged 15-minute
// idle-shutdown default silently takes the MCP endpoint down. This reads the
// *shipped* `mcp:http:dev` argv rather than a hand-copied literal, so dropping
// the override fails here instead of 15 minutes into a session.
const PACKAGE_JSON_PATH = resolve(import.meta.dirname, '../../package.json')
// The server's own default when the script passes no override
// (src/server/index.ts's readArg fallback).
const SERVER_DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000

async function readIdleTimeoutMsFromDevScript(): Promise<number> {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON_PATH, 'utf8'))
  const script: string = pkg.scripts['mcp:http:dev']
  const match = script.match(/--idle-timeout-ms=(\S+)/)
  return match ? Number(match[1]) : SERVER_DEFAULT_IDLE_TIMEOUT_MS
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
