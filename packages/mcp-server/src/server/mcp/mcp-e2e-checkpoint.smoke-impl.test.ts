import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCheckpointChildEnv,
  readDaemonLogsForFailure,
  triggerDaemonDocumentCreate,
} from './mcp-e2e-checkpoint.smoke-impl.js'

describe('buildCheckpointChildEnv', () => {
  it('preserves WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS from the parent env', () => {
    const processEnv = { PATH: '/usr/bin', WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS: '60000' }

    const childEnv = buildCheckpointChildEnv(processEnv, '/tmp/data-dir')

    expect(childEnv.WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS).toBe('60000')
    expect(childEnv.PATH).toBe('/usr/bin')
    expect(childEnv.WHITEBOARD_DATA_DIR).toBe('/tmp/data-dir')
  })

  it('does not invent WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS when absent from the parent env', () => {
    const processEnv = { PATH: '/usr/bin' }

    const childEnv = buildCheckpointChildEnv(processEnv, '/tmp/data-dir')

    expect(childEnv.WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS).toBeUndefined()
  })
})

describe('readDaemonLogsForFailure', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-e2e-log-test-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('returns an empty string when the logs dir does not exist', async () => {
    await expect(readDaemonLogsForFailure(dataDir)).resolves.toBe('')
  })

  it('returns an empty string when the logs dir has no daemon-*.log files', async () => {
    mkdirSync(join(dataDir, 'logs'))
    writeFileSync(join(dataDir, 'logs', 'unrelated.txt'), 'noise')

    await expect(readDaemonLogsForFailure(dataDir)).resolves.toBe('')
  })

  it('surfaces daemon-*.log contents so a startup failure is never diagnosed blind', async () => {
    mkdirSync(join(dataDir, 'logs'))
    writeFileSync(
      join(dataDir, 'logs', 'daemon-2026-01-01.log'),
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx'",
    )

    const detail = await readDaemonLogsForFailure(dataDir)

    expect(detail).toContain('daemon-2026-01-01.log')
    expect(detail).toContain("Cannot find package 'tsx'")
  })
})

describe('triggerDaemonDocumentCreate', () => {
  it('recovers when retry is opted in and the daemon eventually starts', async () => {
    let calls = 0
    const callTool = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('Daemon startup timeout')
      return { id: 'ws_1/e2e-src', url: 'http://localhost/ws_1/e2e-src' }
    })

    const result = await triggerDaemonDocumentCreate(callTool, {
      retryDaemonStartup: true,
      maxDaemonStartupRetries: 1,
    })

    expect(result.id).toBe('ws_1/e2e-src')
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  it('fails immediately on a non-timeout tool error even with retry opted in', async () => {
    const callTool = vi.fn(async () => {
      throw new Error('unexpected tool/call result shape: {}')
    })

    await expect(
      triggerDaemonDocumentCreate(callTool, {
        retryDaemonStartup: true,
        maxDaemonStartupRetries: 2,
      }),
    ).rejects.toThrow('unexpected tool/call result shape: {}')
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('does not retry when retryDaemonStartup is not opted in (default caller semantics)', async () => {
    const callTool = vi.fn(async () => {
      throw new Error('Daemon startup timeout')
    })

    await expect(
      triggerDaemonDocumentCreate(callTool, {
        retryDaemonStartup: false,
        maxDaemonStartupRetries: 3,
      }),
    ).rejects.toThrow('Daemon startup timeout')
    expect(callTool).toHaveBeenCalledTimes(1)
  })
})
