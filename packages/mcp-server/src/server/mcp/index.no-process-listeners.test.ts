import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../config.js'
import { createExcalidrawMcpServer } from './index.js'

// createExcalidrawMcpServer is reused per-request by the HTTP /mcp handler.
// If it ever installed process-level stdin/signal listeners itself (instead
// of only the stdio-only main() doing so via stdio-lifecycle.ts), every HTTP
// request would leak another listener, and an unrelated stdio client's
// disconnect could exit the long-lived HTTP daemon.
describe('createExcalidrawMcpServer process-listener isolation', () => {
  let tmpDataDir: string | undefined

  afterEach(() => {
    resetDataDirForTests()
    if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
    tmpDataDir = undefined
  })

  it('installs no SIGTERM/SIGINT/stdin listeners', async () => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'whiteboard-no-listeners-'))
    setDataDirForTests(tmpDataDir)

    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
      stdinEnd: process.stdin.listenerCount('end'),
      stdinClose: process.stdin.listenerCount('close'),
      stdinError: process.stdin.listenerCount('error'),
    }

    await createExcalidrawMcpServer()

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
    expect(process.listenerCount('SIGINT')).toBe(before.sigint)
    expect(process.stdin.listenerCount('end')).toBe(before.stdinEnd)
    expect(process.stdin.listenerCount('close')).toBe(before.stdinClose)
    expect(process.stdin.listenerCount('error')).toBe(before.stdinError)
  })
})
