import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface RunStdioExitSmokeOptions {
  /** Absolute path to the MCP server entry point (.ts for dev, .js for packaged). */
  entry: string
  /** Package root used as cwd for the spawned child process. */
  root: string
  /** How the child should be told to stop: closing stdin, or a POSIX signal. */
  trigger: 'stdin-end' | 'SIGTERM' | 'SIGINT'
  /** Bound on how long we wait for the child to exit after the trigger. */
  exitTimeoutMs?: number
}

function spawnMcpChild(
  entry: string,
  root: string,
  dataDir: string,
): ChildProcessWithoutNullStreams {
  const childArgs = entry.endsWith('.ts') ? ['--import', 'tsx/esm', entry] : [entry]
  return spawn('node', childArgs, {
    cwd: root,
    env: { ...process.env, WHITEBOARD_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * Spawns the real stdio entry, performs a full MCP initialize handshake so
 * the server is actually up and connected to the transport, then applies
 * `trigger` and asserts the process exits promptly on its own (never needing
 * SIGKILL). This is the regression guard for the production busy-spin: a
 * stdio child whose parent disappears (stdin EOF) or that is asked to stop
 * (SIGTERM/SIGINT) must exit instead of spinning indefinitely.
 */
export async function runStdioExitSmoke({
  entry,
  root,
  trigger,
  exitTimeoutMs = 5000,
}: RunStdioExitSmokeOptions): Promise<void> {
  const tmpDataDir = mkdtempSync(join(tmpdir(), 'whiteboard-stdio-exit-'))
  const child = spawnMcpChild(entry, root, tmpDataDir)

  let stderrBuf = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })

  // Without a listener here, a premature child exit (e.g. EPIPE on a write
  // after the process has already gone away) throws an unhandled 'error'
  // event and crashes the test runner instead of surfacing as a normal
  // assertion failure below.
  child.stdin.on('error', () => {})

  let stdoutBuf = ''
  let sawInitializeResponse = false
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString()
    if (!sawInitializeResponse && stdoutBuf.includes('"id":1')) {
      sawInitializeResponse = true
    }
  })

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }))
    },
  )

  const cleanup = () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    } catch {}
    // maxRetries/retryDelay absorb the window where the OS hasn't yet
    // released its handle on tmpDataDir right after killing the child
    // (observed as EBUSY/EPERM on Windows).
    rmSync(tmpDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
  process.once('exit', cleanup)

  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'stdio-exit-smoke', version: '0.0.0' },
        },
      })}\n`,
    )

    const deadline = Date.now() + exitTimeoutMs
    while (!sawInitializeResponse && Date.now() < deadline) {
      // A child that has already died can never produce the response we're
      // waiting for; fail immediately instead of spinning until the timeout.
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `[stdio-exit-smoke] child exited before sending an initialize response ` +
            `(code=${child.exitCode} signal=${child.signalCode})\n${stderrBuf}`,
        )
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    if (!sawInitializeResponse) {
      throw new Error(`[stdio-exit-smoke] never observed initialize response\n${stderrBuf}`)
    }
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
    )

    switch (trigger) {
      case 'stdin-end':
        child.stdin.end()
        break
      case 'SIGTERM':
        child.kill('SIGTERM')
        break
      case 'SIGINT':
        child.kill('SIGINT')
        break
    }

    const result = await Promise.race([
      exitPromise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), exitTimeoutMs)),
    ])

    if (result === 'timeout') {
      throw new Error(
        `[stdio-exit-smoke] process did not exit within ${exitTimeoutMs}ms after ${trigger}${
          stderrBuf ? `\n${stderrBuf}` : ''
        }`,
      )
    }
    if (result.code !== 0) {
      throw new Error(
        `[stdio-exit-smoke] process exited with code=${result.code} signal=${result.signal}${
          stderrBuf ? `\n${stderrBuf}` : ''
        }`,
      )
    }
  } finally {
    process.removeListener('exit', cleanup)
    cleanup()
  }
}
