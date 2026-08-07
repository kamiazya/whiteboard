// Subprocess-level tests of the dev stdio->HTTP MCP proxy. The proxy is the
// piece that makes the dev daemon reliably reachable from MCP clients: the
// client spawns a local stdio process (which always succeeds), and THIS
// process absorbs the two failure modes that used to strand a session —
// the daemon not being up yet at client start, and the tsx-watch restart
// window. Each stdin JSON-RPC line becomes one authenticated POST /mcp;
// connection failures retry within a budget instead of failing the client.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeMcpResponder } from './test-utils/fake-mcp-daemon.mjs'

const PROXY_SCRIPT_PATH = resolve(import.meta.dirname, 'mcp-http-stdio-proxy.mjs')
const HOST = '127.0.0.1'
const TOKEN = 'proxy-test-token'

async function reserveFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const tester = createServer()
    tester.once('error', rejectPort)
    tester.listen(0, HOST, () => {
      const address = tester.address()
      const port = typeof address === 'object' && address ? address.port : undefined
      tester.close(() => {
        if (port === undefined) rejectPort(new Error('failed to reserve a free port'))
        else resolvePort(port as number)
      })
    })
  })
}

let child: ChildProcessWithoutNullStreams | null = null
let closeResponder: (() => Promise<unknown>) | null = null

function spawnProxy(port: number, envOverrides: Record<string, string> = {}) {
  child = spawn(process.execPath, [PROXY_SCRIPT_PATH], {
    env: {
      ...process.env,
      WHITEBOARD_DEV_PORT: String(port),
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
  if (closeResponder) {
    await closeResponder()
    closeResponder = null
  }
})

describe('mcp-http-stdio-proxy (subprocess)', () => {
  it('forwards a stdin request as an authenticated POST and writes the JSON response line', async () => {
    const port = await reserveFreePort()
    const responder = await startFakeMcpResponder({ port, token: TOKEN })
    closeResponder = responder.close
    const proc = spawnProxy(port)

    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
    const line = await nextStdoutLine(proc)
    const parsed = JSON.parse(line)
    expect(parsed.jsonrpc).toBe('2.0')
    expect(parsed).toHaveProperty('result')
  })

  it('holds a request across a backend that is not up yet (startup race / watch restart)', async () => {
    const port = await reserveFreePort()
    const proc = spawnProxy(port)

    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    // Backend comes up AFTER the request was written.
    await new Promise((r) => setTimeout(r, 500))
    const responder = await startFakeMcpResponder({ port, token: TOKEN })
    closeResponder = responder.close

    const line = await nextStdoutLine(proc)
    expect(JSON.parse(line)).toHaveProperty('result')
  })

  it('writes nothing to stdout for a notification (no id)', async () => {
    const port = await reserveFreePort()
    const responder = await startFakeMcpResponder({ port, token: TOKEN })
    closeResponder = responder.close
    const proc = spawnProxy(port)

    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`)

    // The first stdout line must be the RESPONSE to id 3 — the notification
    // produced no line of its own.
    const line = await nextStdoutLine(proc)
    expect(JSON.parse(line).id).toBe('fake-mcp-daemon')
  })

  it('an invalid retry-timeout override falls back to the default instead of wedging', async () => {
    const port = await reserveFreePort()
    const responder = await startFakeMcpResponder({ port, token: TOKEN })
    closeResponder = responder.close
    // NaN/Infinity would otherwise make the retry deadline unreachable.
    const proc = spawnProxy(port, { WHITEBOARD_PROXY_RETRY_TIMEOUT_MS: 'Infinity' })
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })}\n`)
    const line = await nextStdoutLine(proc)
    expect(JSON.parse(line)).toHaveProperty('result')
  })

  it('a non-JSON 4xx from the endpoint becomes a JSON-RPC error, not garbage on stdout', async () => {
    const port = await reserveFreePort()
    // A plain HTTP server that is NOT an MCP endpoint: 404 with an HTML body.
    const { createServer: createHttpServer } = await import('node:http')
    const server = createHttpServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<html>not found</html>')
    })
    await new Promise<void>((r) => server.listen(port, HOST, () => r()))
    closeResponder = () => new Promise((r) => server.close(() => r(undefined)))

    const proc = spawnProxy(port)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' })}\n`)
    const line = await nextStdoutLine(proc)
    const parsed = JSON.parse(line)
    expect(parsed.id).toBe(4)
    expect(parsed.error.message).toContain('HTTP 404')
  })

  it('exits cleanly when stdin closes', async () => {
    const port = await reserveFreePort()
    const responder = await startFakeMcpResponder({ port, token: TOKEN })
    closeResponder = responder.close
    const proc = spawnProxy(port)

    const exited = new Promise<number | null>((resolveExit) =>
      proc.once('exit', (code) => resolveExit(code)),
    )
    proc.stdin.end()
    expect(await exited).toBe(0)
    child = null
  })
})
