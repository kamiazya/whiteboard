import { type ChildProcess, spawn } from 'node:child_process'
import { request } from 'node:http'

/**
 * The real `whiteboard daemon run`, and the three things a browser does to
 * it over its owner-only socket: plain requests, an SSE stream, and POSTs that
 * subscribe that stream to documents.
 */
export interface DaemonProcess {
  /** An authenticated request over the daemon's socket. */
  fetch(path: string, init?: { method?: string; body?: unknown }): Promise<DaemonResponse>
  /** Opens a sync stream and answers what arrives on it. */
  openStream(): Promise<SseStream>
  stop(): void
}

interface DaemonResponse {
  status: number
  bytes: Buffer
  json(): unknown
}

interface SseFrame {
  event: string
  data: unknown
}

interface SseStream {
  streamId: string
  /** Every frame received so far, in order. */
  frames(): readonly SseFrame[]
  subscribe(keys: readonly string[]): Promise<void>
  close(): void
}

export interface StartDaemonOptions {
  root: string
  /** The `.ts` CLI entry, run through tsx. */
  cliEntry: string
  dataDir: string
  /** Where the owner-only socket is made; a fresh directory keeps runs apart. */
  runtimeDir: string
  token: string
  /** Added to the daemon's environment over the parent's. */
  env?: Record<string, string>
}

function socketRequest(
  socketPath: string,
  token: string,
  path: string,
  init: { method?: string; body?: unknown },
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          resolve({
            status: res.statusCode ?? 0,
            bytes,
            json: () => JSON.parse(bytes.toString()),
          })
        })
      },
    )
    req.on('error', reject)
    if (init.body !== undefined) req.write(JSON.stringify(init.body))
    req.end()
  })
}

function parseFrames(buffered: string): { frames: SseFrame[]; rest: string } {
  const blocks = buffered.split('\n\n')
  const rest = blocks.pop() ?? ''
  const frames: SseFrame[] = []
  for (const block of blocks) {
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (data !== '') frames.push({ event, data: JSON.parse(data) as unknown })
  }
  return { frames, rest }
}

async function openSseStream(
  socketPath: string,
  token: string,
  post: DaemonProcess['fetch'],
): Promise<SseStream> {
  const received: SseFrame[] = []
  let buffered = ''
  const req = request({
    socketPath,
    path: '/api/sync/stream',
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
  })
  req.on('response', (res) => {
    res.on('data', (chunk: Buffer) => {
      const parsed = parseFrames(buffered + chunk.toString())
      buffered = parsed.rest
      received.push(...parsed.frames)
    })
  })
  req.on('error', () => {})
  req.end()
  const ready = await waitForFrame(received, 'ready')
  const streamId = (ready.data as { streamId: string }).streamId
  return {
    streamId,
    frames: () => received,
    async subscribe(keys) {
      const res = await post('/api/sync/subscribe', {
        method: 'POST',
        body: { streamId, subscribe: keys },
      })
      if (res.status !== 200) throw new Error(`subscribe answered ${res.status}`)
    },
    close: () => req.destroy(),
  }
}

async function waitForFrame(frames: readonly SseFrame[], event: string): Promise<SseFrame> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = frames.find((frame) => frame.event === event)
    if (found !== undefined) return found
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error(`no ${event} frame arrived on the sync stream`)
}

function whenReady(child: ChildProcess, stderr: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const line = out.split('\n')[0]
      if (out.includes('\n') && line !== undefined) resolve(line)
    })
    child.on('exit', (code) =>
      reject(new Error(`daemon exited ${code} before it was ready\n${stderr()}`)),
    )
  })
}

export async function startDaemon(options: StartDaemonOptions): Promise<DaemonProcess> {
  // An operator's own tail interval would turn this into a test of THEIR
  // setting rather than of the daemon's default.
  const { WHITEBOARD_WORKSPACE_TAIL_MS: _inherited, ...inherited } = process.env
  const child = spawn(
    'node',
    [
      '--import',
      'tsx/esm',
      options.cliEntry,
      'daemon',
      'run',
      '--json',
      '--no-open',
      `--data-dir=${options.dataDir}`,
    ],
    {
      cwd: options.root,
      env: {
        ...inherited,
        XDG_RUNTIME_DIR: options.runtimeDir,
        WHITEBOARD_DAEMON_TOKEN: options.token,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const ready = JSON.parse(await whenReady(child, () => stderr)) as { socketPath: string }
  const fetch: DaemonProcess['fetch'] = (path, init = {}) =>
    socketRequest(ready.socketPath, options.token, path, init)
  const streams: SseStream[] = []
  return {
    fetch,
    async openStream() {
      const stream = await openSseStream(ready.socketPath, options.token, fetch)
      streams.push(stream)
      return stream
    },
    stop() {
      for (const stream of streams) stream.close()
      child.kill('SIGKILL')
    },
  }
}
