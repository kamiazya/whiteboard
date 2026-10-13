// Subprocess-level tests of the dev stdio->HTTP MCP proxy. The proxy is the
// piece that makes the dev daemon reliably reachable from MCP clients: the
// client spawns a local stdio process (which always succeeds), and THIS
// process absorbs the two failure modes that used to strand a session —
// the daemon not being up yet at client start, and the tsx-watch restart
// window. Each stdin JSON-RPC line becomes one authenticated POST /mcp on
// the socket the daemon record names; connection failures retry within a
// budget instead of failing the client.
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type RunningServer, startHttpServer } from '../../src/server/http-server.js'
import { getLogLevel, type LogLevel, setLogLevel } from '../../src/server/log.js'
import {
  CANVAS_VIEW_RESOURCE_URI,
  resetWidgetHtmlCacheForTests,
} from '../../src/server/mcp/mcp-apps.js'
import { WHITEBOARD_DRAW_PROMPT } from '../../src/server/mcp/standalone-help.js'
import {
  claimIsolatedDataDir,
  releaseIsolatedDataDir,
} from '../../src/shared/test-utils/isolated-data-dir.js'
import { repoRoot } from '../../src/shared/test-utils/repo-root.js'
import { startFakeMcpResponder } from './test-utils/fake-mcp-daemon.mjs'

const PROXY_SCRIPT_PATH = resolve(import.meta.dirname, 'mcp-http-stdio-proxy.mjs')
const SCRIPT_FLAGS_PATH = join(repoRoot(), '.claude/scripts/script-flags.mjs')
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

/** Every stdout line the proxy writes, once it has exited. Attach before writing to stdin. */
function stdoutLinesUntilExit(proc: ChildProcessWithoutNullStreams): Promise<string[]> {
  let out = ''
  proc.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  return new Promise((resolveLines) =>
    proc.once('close', () => resolveLines(out.split('\n').filter((line) => line !== ''))),
  )
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

  it('writes a streamed message as it arrives, before the stream ends', async () => {
    const { dataDir, socketPath } = dataDirWithRecord()
    // A stream that sends one message and then stays open, the shape of a
    // long-lived listen: nothing ends it, so a proxy that waits for the end
    // never writes anything.
    const open: Array<{ end: () => void }> = []
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'early' } })}\n\n`,
      )
      open.push(res)
    })
    await new Promise<void>((r) => server.listen(socketPath, () => r()))
    cleanups.push(
      () =>
        new Promise((r) => {
          for (const res of open) res.end()
          server.close(() => r(undefined))
        }),
    )

    const proc = spawnProxy(dataDir)
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'subscriptions/listen' })}\n`,
    )
    const first = JSON.parse(await nextStdoutLine(proc))
    expect(first.method).toBe('notifications/message')
    expect(first.params.data).toBe('early')
  })

  // stdout IS the JSON-RPC channel: a stray SSE line or a duplicated message
  // corrupts what the client reads, and an SDK client tolerates unparseable
  // lines, so only a test reading every line sees it. Every line is collected
  // until the proxy drains and exits on stdin close, so nothing written after
  // the relay can escape the assertion.
  const streamNote = JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', data: 'early' },
  })
  const streamResult = JSON.stringify({ jsonrpc: '2.0', id: 6, result: { content: [] } })
  const sse = (message: string) => `event: message\ndata: ${message}\n\n`

  it('puts only the messages of an event stream that ends on stdout, once each', async () => {
    const { dataDir, socketPath } = dataDirWithRecord()
    const server = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`${sse(streamNote)}${sse(streamResult)}`)
    })
    await new Promise<void>((r) => server.listen(socketPath, () => r()))
    cleanups.push(() => new Promise((r) => server.close(() => r(undefined))))

    const proc = spawnProxy(dataDir)
    const lines = stdoutLinesUntilExit(proc)
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'x' } })}\n`,
    )
    proc.stdin.end()

    const written = await lines
    for (const line of written) expect(() => JSON.parse(line), line).not.toThrow()
    expect(written).toEqual([streamNote, streamResult])
  })

  it('does not re-send a stream cut after its first message', async () => {
    const { dataDir, socketPath } = dataDirWithRecord()
    let requests = 0
    const open: Array<{ destroy: () => void }> = []
    const server = createHttpServer((_req, res) => {
      requests += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse(streamNote))
      // A retry, if one comes, is cut at once so the proxy still drains and exits.
      if (requests === 1) open.push(res)
      else res.destroy()
    })
    await new Promise<void>((r) => server.listen(socketPath, () => r()))
    cleanups.push(
      () =>
        new Promise((r) => {
          server.closeAllConnections()
          server.close(() => r(undefined))
        }),
    )

    // A short retry budget: a proxy that does retry the cut stream still exits.
    const proc = spawnProxy(dataDir, { WHITEBOARD_PROXY_RETRY_TIMEOUT_MS: '2000' })
    const lines = stdoutLinesUntilExit(proc)
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } })}\n`,
    )
    // Cut only once the message has reached the client, so it is a cut AFTER output.
    expect(JSON.parse(await nextStdoutLine(proc)).params.data).toBe('early')
    for (const res of open.splice(0)) res.destroy()
    proc.stdin.end()

    const written = await lines
    expect(requests).toBe(1)
    expect(written.filter((line) => line.includes('early'))).toHaveLength(1)
    expect(JSON.parse(written.at(-1) ?? '{}')).toMatchObject({ id: 7, error: { code: -32000 } })
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

// The endpoint refuses a modern request whose standard headers do not mirror
// its body, and which method mirrors which field — plus how a value is encoded
// — is the SDK's private table, copied into the proxy. So the proxy is held to
// whatever SDK is installed: the same line through the SDK's own HTTP transport
// and through the proxy must carry the same standard headers.
describe('mcp-http-stdio-proxy standard headers match the SDK client', () => {
  const STANDARD_HEADERS = ['mcp-protocol-version', 'mcp-method', 'mcp-name'] as const
  type StandardHeaders = Record<(typeof STANDARD_HEADERS)[number], string | undefined>
  const pick = (read: (name: string) => string | undefined): StandardHeaders =>
    Object.fromEntries(STANDARD_HEADERS.map((name) => [name, read(name)])) as StandardHeaders

  const modern = (method: string, params: Record<string, unknown>) => ({
    method,
    params: { ...params, _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28' } },
  })
  const cases = [
    modern('tools/call', { name: 'wb_workspace_edit', arguments: {} }),
    modern('tools/call', { name: 'ツール', arguments: {} }),
    // Already shaped like the sentinel, so it must be encoded to stay unambiguous.
    modern('tools/call', { name: '=?base64?aGk=?=', arguments: {} }),
    modern('tools/call', { name: ' padded ', arguments: {} }),
    modern('resources/read', { uri: 'ui://whiteboard/canvas-view' }),
    modern('resources/read', { uri: 'ui://whiteboard/ノート' }),
    modern('prompts/get', { name: 'whiteboard.draw_diagram', arguments: {} }),
    modern('prompts/get', { name: '図を描く', arguments: {} }),
    modern('tasks/get', { taskId: 'task-1' }),
    modern('tasks/update', { taskId: 'task-2' }),
    modern('tasks/cancel', { taskId: 'タスク' }),
    // Off the Mcp-Name table: no Mcp-Name on either path.
    modern('tools/list', {}),
    // No era claim: a legacy request carries none of the three.
    { method: 'tools/call', params: { name: 'wb_workspace_edit', arguments: {} } },
  ]

  async function headersFromSdk(message: object): Promise<StandardHeaders> {
    let sent: Headers | undefined
    const transport = new StreamableHTTPClientTransport(new URL('http://sdk.invalid/mcp'), {
      fetch: async (_url, init) => {
        sent = new Headers(init?.headers)
        return new Response(null, { status: 202 })
      },
    })
    await transport.start()
    await transport.send(message as Parameters<typeof transport.send>[0])
    await transport.close()
    if (sent === undefined) throw new Error('the SDK transport sent nothing')
    const headers = sent
    return pick((name) => headers.get(name) ?? undefined)
  }

  it('sends the SDK transport’s MCP-Protocol-Version, Mcp-Method and Mcp-Name', async () => {
    const { dataDir, socketPath } = dataDirWithRecord()
    const seen = new Map<number, StandardHeaders>()
    const server = createHttpServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const { id } = JSON.parse(body)
        seen.set(
          id,
          pick((name) => {
            const value = req.headers[name]
            return Array.isArray(value) ? value.join(', ') : value
          }),
        )
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: {} }))
      })
    })
    await new Promise<void>((r) => server.listen(socketPath, () => r()))
    cleanups.push(() => new Promise((r) => server.close(() => r(undefined))))
    const proc = spawnProxy(dataDir)

    for (const [index, shape] of cases.entries()) {
      const message = { jsonrpc: '2.0' as const, id: index + 1, ...shape }
      proc.stdin.write(`${JSON.stringify(message)}\n`)
      expect(JSON.parse(await nextStdoutLine(proc)).id).toBe(message.id)
      expect({ method: shape.method, headers: seen.get(message.id) }).toEqual({
        method: shape.method,
        headers: await headersFromSdk(message),
      })
    }
    // The comparison reaches every row the proxy's table holds, and both
    // branches of the encoding.
    const names = [...seen.values()].map((headers) => headers['mcp-name'])
    expect(names.filter((name) => name?.startsWith('=?base64?')).length).toBeGreaterThan(3)
    expect(names.filter((name) => name !== undefined && !name.startsWith('=?'))).toHaveLength(5)
  })
})

// A client that negotiates sees exactly what it would see on the daemon's own
// socket: the proxy derives the modern era's standard request headers from
// each line, and relays every message of a streamed reply, so the in-call log
// records a modern request opts into arrive ahead of its result.
describe('mcp-http-stdio-proxy against the real daemon', () => {
  const MODERN = '2026-07-28'
  const WIDGET_HTML = '<!doctype html><title>proxy widget</title>'
  let running: RunningServer | undefined
  let scratchDataDir = ''
  let recordDir = ''
  let previousLevel: LogLevel = 'warning'

  beforeAll(async () => {
    scratchDataDir = claimIsolatedDataDir('proxy-eras')
    previousLevel = getLogLevel()
    // The records a call emits pass the daemon's own threshold first.
    setLogLevel('debug')
    recordDir = mkdtempSync(join(tmpdir(), 'wb-proxy-real-'))
    // In the record dir rather than `testSocketPath()`'s, which is per test.
    const socketPath = join(recordDir, 'd.sock')
    running = await startHttpServer({ socketPath, token: TOKEN })
    writeFileSync(join(recordDir, 'daemon.json'), JSON.stringify({ pid: process.pid, socketPath }))
    // The widget is a build output a test run need not have; a fixture stands in.
    const widgetPath = join(recordDir, 'canvas-viewer.html')
    writeFileSync(widgetPath, WIDGET_HTML)
    resetWidgetHtmlCacheForTests(widgetPath)
  })

  afterAll(async () => {
    await running?.close()
    resetWidgetHtmlCacheForTests()
    setLogLevel(previousLevel)
    rmSync(recordDir, { recursive: true, force: true })
    releaseIsolatedDataDir(scratchDataDir)
  })

  async function connect(versionNegotiation?: { mode: 'auto' }) {
    const client = new Client(
      { name: 'proxy-eras', version: '1' },
      versionNegotiation === undefined ? undefined : { versionNegotiation },
    )
    const order: string[] = []
    client.setNotificationHandler('notifications/message', () => {
      order.push('record')
    })
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [PROXY_SCRIPT_PATH],
      env: {
        ...(process.env as Record<string, string>),
        WHITEBOARD_DATA_DIR: recordDir,
        WHITEBOARD_TOKEN: TOKEN,
        WHITEBOARD_PROXY_SKIP_ENSURE: '1',
        WHITEBOARD_PROXY_RETRY_TIMEOUT_MS: '5000',
      },
      stderr: 'ignore',
    })
    cleanups.push(() => client.close())
    await client.connect(transport)
    return { client, order }
  }

  // A fresh path per call: the daemon outlives each test (and each repeat), so
  // a fixed path would already exist on the second run.
  let calls = 0
  function createCall(name: string, meta?: Record<string, unknown>) {
    calls += 1
    const path = `${name}-${calls}`
    return {
      name: 'wb_workspace_edit',
      arguments: {
        workspaceId: 'default',
        ops: [{ op: 'document.create', path, kind: 'markdown', markdown: '# hi\n' }],
      },
      ...(meta === undefined ? {} : { _meta: meta }),
    }
  }

  it('carries a negotiating client into the modern era with its log records', async () => {
    const { client, order } = await connect({ mode: 'auto' })
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN)

    const result = await client.callTool(
      createCall('proxy-modern', { 'io.modelcontextprotocol/logLevel': 'debug' }),
    )
    order.push('result')

    expect(result.isError ?? false).toBe(false)
    expect(order[0]).toBe('record')
    expect(order.at(-1)).toBe('result')
  })

  // The endpoint checks Mcp-Name against params.uri and params.name for these,
  // the rows besides tools/call the daemon serves.
  it('reads the widget resource and gets the prompt in the modern era', async () => {
    const { client } = await connect({ mode: 'auto' })
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN)

    const resource = await client.readResource({ uri: CANVAS_VIEW_RESOURCE_URI })
    expect(resource.contents).toEqual([expect.objectContaining({ text: WIDGET_HTML })])

    const prompt = await client.getPrompt({
      name: WHITEBOARD_DRAW_PROMPT,
      arguments: { goal: 'map the proxy' },
    })
    expect(JSON.stringify(prompt.messages)).toContain('map the proxy')
  })

  it('still serves a client that never negotiates', async () => {
    const { client } = await connect()
    expect(client.getNegotiatedProtocolVersion()).not.toBe(MODERN)

    const result = await client.callTool(createCall('proxy-legacy'))
    expect(result.isError ?? false).toBe(false)
  })
})

/** A throwaway git checkout, removed after the test. */
function scratchCheckout(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  return root
}

/**
 * A checkout carrying copies of these dev scripts at their real relative paths
 * — a symlink would not do, because node resolves an ES module through it to
 * the real file, whose checkout is this one.
 */
function checkoutWithDevScripts(): { root: string; proxy: string } {
  const root = scratchCheckout('wb-proxy-a-')
  const devDir = join(root, 'packages/mcp-server/scripts/dev')
  cpSync(import.meta.dirname, devDir, {
    recursive: true,
    filter: (source) => !source.endsWith('.ts'),
  })
  // The hook reads the package script it starts from the checkout's manifest.
  cpSync(
    resolve(import.meta.dirname, '../../package.json'),
    join(root, 'packages/mcp-server/package.json'),
  )
  // The proxy imports the MCP SDK, which an installed checkout resolves here.
  symlinkSync(
    resolve(import.meta.dirname, '../../node_modules'),
    join(root, 'packages/mcp-server/node_modules'),
    'dir',
  )
  mkdirSync(join(root, '.claude/scripts'), { recursive: true })
  cpSync(SCRIPT_FLAGS_PATH, join(root, '.claude/scripts/script-flags.mjs'))
  return { root, proxy: join(devDir, 'mcp-http-stdio-proxy.mjs') }
}

/** The fake daemon the hook starts in place of the real wrapper, in `checkoutRoot`'s copy. */
function fakeDevServer(checkoutRoot: string): string {
  return join(checkoutRoot, 'packages/mcp-server/scripts/dev/test-utils/fake-pnpm-shim.mjs')
}

function killRecordedDaemon(dataDir: string) {
  try {
    process.kill(JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')).pid, 'SIGKILL')
  } catch {
    /* no record, or already gone */
  }
}

// One `whiteboard` registration serves a repository (wire-worktree-mcp.mjs),
// and it holds the MAIN checkout's proxy, so a session opened in a linked
// worktree runs that proxy with the worktree as its working directory and
// CLAUDE_PROJECT_DIR. The proxy reads the main checkout's record; the daemon it
// ensures has to be that one too, or the session's every request waits for a
// record nothing will write.
describe.skipIf(process.platform === 'win32')('mcp-http-stdio-proxy ensure step', () => {
  it("ensures the daemon of the proxy's own checkout, not the session's", async () => {
    const a = checkoutWithDevScripts()
    const b = scratchCheckout('wb-proxy-b-')
    cleanups.push(() => killRecordedDaemon(join(a.root, '.dev-data')))
    cleanups.push(() => killRecordedDaemon(join(b, '.dev-data')))
    const { WHITEBOARD_DATA_DIR: _unset, ...inherited } = process.env
    child = spawn(process.execPath, [a.proxy], {
      cwd: b,
      env: {
        ...inherited,
        CLAUDE_PROJECT_DIR: b,
        WHITEBOARD_DEV_SERVER_STAND_IN: fakeDevServer(a.root),
        WHITEBOARD_TOKEN: TOKEN,
        WHITEBOARD_DEV_READY_TIMEOUT_MS: '5000',
        WHITEBOARD_PROXY_RETRY_TIMEOUT_MS: '2000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' })}\n`)
    const response = JSON.parse(await nextStdoutLine(child))

    expect(existsSync(join(b, '.dev-data'))).toBe(false)
    expect(existsSync(join(a.root, '.dev-data', 'daemon.json'))).toBe(true)
    expect(response).toHaveProperty('result')
  })
})
