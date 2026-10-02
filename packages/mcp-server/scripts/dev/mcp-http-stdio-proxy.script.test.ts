// Subprocess-level tests of the dev stdio->HTTP MCP proxy. The proxy is the
// piece that makes the dev daemon reliably reachable from MCP clients: the
// client spawns a local stdio process (which always succeeds), and THIS
// process absorbs the two failure modes that used to strand a session —
// the daemon not being up yet at client start, and the tsx-watch restart
// window. Each stdin JSON-RPC line becomes one authenticated POST /mcp on
// the socket the daemon record names; connection failures retry within a
// budget instead of failing the client.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeMcpResponder } from './test-utils/fake-mcp-daemon.mjs'

const PROXY_SCRIPT_PATH = resolve(import.meta.dirname, 'mcp-http-stdio-proxy.mjs')
const TOKEN = 'proxy-test-token'

let child: ChildProcessWithoutNullStreams | null = null
const cleanups: Array<() => unknown> = []

/** A data dir whose record names `daemon.sock` inside it. */
function dataDirWithRecord(): { dataDir: string; socketPath: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-proxy-'))
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const socketPath = join(dataDir, 'daemon.sock')
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, socketPath }))
  return { dataDir, socketPath }
}

async function startResponder(socketPath: string) {
  const responder = await startFakeMcpResponder({ token: TOKEN, socketPath })
  cleanups.push(responder.close)
}

function spawnProxy(dataDir: string, envOverrides: Record<string, string> = {}) {
  child = spawn(process.execPath, [PROXY_SCRIPT_PATH], {
    env: {
      ...process.env,
      WHITEBOARD_DATA_DIR: dataDir,
      WHITEBOARD_TOKEN: TOKEN,
      // Tests own the backend lifecycle; never spawn the real hook.
      WHITEBOARD_PROXY_SKIP_ENSURE: '1',
      WHITEBOARD_PROXY_RETRY_TIMEOUT_MS: '5000',
      ...envOverrides,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return child
}

function nextStdoutLine(proc: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = ''
    const settle = (fn: () => void) => {
      proc.stdout.off('data', onData)
      proc.off('exit', onExit)
      clearTimeout(timer)
      fn()
    }
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline !== -1) settle(() => resolveLine(buffer.slice(0, newline)))
    }
    const onExit = (code: number | null) =>
      settle(() => rejectLine(new Error(`proxy exited early (code ${code})`)))
    const timer = setTimeout(
      () => settle(() => rejectLine(new Error('timed out waiting for a stdout line'))),
      8_000,
    )
    proc.stdout.on('data', onData)
    proc.once('exit', onExit)
  })
}

afterEach(async () => {
  if (child) {
    child.kill('SIGTERM')
    child = null
  }
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('mcp-http-stdio-proxy (subprocess)', () => {
  it('forwards a stdin request as an authenticated POST on the recorded socket', async () => {
    const { dataDir, socketPath } = dataDirWithRecord()
    await startResponder(socketPath)
    const proc = spawnProxy(dataDir)

    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
    const parsed = JSON.parse(await nextStdoutLine(proc))
    expect(parsed.jsonrpc).toBe('2.0')
    expect(parsed).toHaveProperty('result')
  })

  it('holds a request until the daemon records its socket, and never tries the port', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wb-proxy-'))
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }))
    let tcpConnections = 0
    const tcp = createServer((socket) => {
      tcpConnections += 1
      socket.destroy()
    })
    await new Promise<void>((listening) => tcp.listen(0, '127.0.0.1', () => listening()))
    cleanups.push(() => new Promise((closed) => tcp.close(() => closed(undefined))))
    const address = tcp.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const proc = spawnProxy(dataDir, { WHITEBOARD_DEV_PORT: String(port) })

    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    // The daemon comes up AFTER the request was written (startup race, or
    // the window of a watch restart in which it has no record).
    await new Promise((r) => setTimeout(r, 500))
    const socketPath = join(dataDir, 'daemon.sock')
    await startResponder(socketPath)
    writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, socketPath }))

    expect(JSON.parse(await nextStdoutLine(proc))).toHaveProperty('result')
    expect(tcpConnections).toBe(0)
  })

  it('writes nothing to stdout for a notification (no id)', async () => {
    const { dataDir, socketPath } = dataDirWithRecord()
    await startResponder(socketPath)
    const proc = spawnProxy(dataDir)

    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`)

    // The first stdout line must be the RESPONSE to id 3 — the notification
    // produced no line of its own.
    expect(JSON.parse(await nextStdoutLine(proc)).id).toBe('fake-mcp-daemon')
  })

  it('an invalid retry-timeout override falls back to the default instead of wedging', async () => {
    const { dataDir, socketPath } = dataDirWithRecord()
    await startResponder(socketPath)
    // NaN/Infinity would otherwise make the retry deadline unreachable.
    const proc = spawnProxy(dataDir, { WHITEBOARD_PROXY_RETRY_TIMEOUT_MS: 'Infinity' })
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })}\n`)
    expect(JSON.parse(await nextStdoutLine(proc))).toHaveProperty('result')
  })

  it('a non-JSON 4xx from the endpoint becomes a JSON-RPC error, not garbage on stdout', async () => {
    const { dataDir, socketPath } = dataDirWithRecord()
    // A plain HTTP server that is NOT an MCP endpoint: 404 with an HTML body.
    const server = createHttpServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<html>not found</html>')
    })
    await new Promise<void>((r) => server.listen(socketPath, () => r()))
    cleanups.push(() => new Promise((r) => server.close(() => r(undefined))))

    const proc = spawnProxy(dataDir)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' })}\n`)
    const parsed = JSON.parse(await nextStdoutLine(proc))
    expect(parsed.id).toBe(4)
    expect(parsed.error.message).toContain('HTTP 404')
  })

  it('exits cleanly when stdin closes', async () => {
    const { dataDir, socketPath } = dataDirWithRecord()
    await startResponder(socketPath)
    const proc = spawnProxy(dataDir)

    const exited = new Promise<number | null>((resolveExit) =>
      proc.once('exit', (code) => resolveExit(code)),
    )
    proc.stdin.end()
    expect(await exited).toBe(0)
    child = null
  })
})
