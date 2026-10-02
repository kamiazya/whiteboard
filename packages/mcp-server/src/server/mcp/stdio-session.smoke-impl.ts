import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

/**
 * A real stdio MCP process, driven the way a client drives it: newline-framed
 * JSON-RPC over the child's pipes. Shared by the smokes that need a second
 * process over one data dir, because what they exist to see — the wiring a
 * unit test over a declaration cannot reach — only shows with a whole process.
 */
export interface StdioSession {
  call(name: string, args: unknown): Promise<Record<string, unknown>>
  /** Closes stdin, as a client disconnecting does, and resolves with the exit code. */
  end(): Promise<number | null>
  /** For teardown: stops the process without waiting for it to say goodbye. */
  kill(): void
}

type Rpc = (method: string, params: unknown) => Promise<unknown>

/** Newline-framed JSON-RPC over the child's pipes, correlated back by id. */
function jsonRpcOver(child: ChildProcessWithoutNullStreams, stderr: () => string): Rpc {
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>()
  let buffered = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString()
    for (let at = buffered.indexOf('\n'); at !== -1; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
        if (message.id !== undefined) pending.get(message.id)?.(message)
      } catch {
        // Not a frame: the stream is not this client's alone.
      }
    }
  })

  let nextId = 1
  return (method, params) =>
    new Promise<unknown>((done, fail) => {
      const id = nextId++
      pending.set(id, (message) =>
        message.error === undefined
          ? done(message.result)
          : fail(new Error(`${method}: ${JSON.stringify(message.error)}\n${stderr()}`)),
      )
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
}

export interface OpenStdioSessionOptions {
  /** The package root, used as the child's cwd. */
  root: string
  /** The `.ts` stdio entry, run through tsx. */
  entry: string
  /** Added to the child's environment over the parent's. */
  env: Record<string, string>
  clientName: string
}

export async function openStdioSession(options: OpenStdioSessionOptions): Promise<StdioSession> {
  const child: ChildProcessWithoutNullStreams = spawn(
    'node',
    ['--import', 'tsx/esm', options.entry],
    {
      cwd: options.root,
      env: { ...process.env, WHITEBOARD_NO_WATCH: '1', ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  child.stdin.on('error', () => {})
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)))
  const rpc = jsonRpcOver(child, () => stderr)

  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: options.clientName, version: '0.0.0' },
  })
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
  )
  return {
    async call(name, args) {
      const result = (await rpc('tools/call', { name, arguments: args })) as {
        content: { text: string }[]
        isError?: boolean
      }
      const text = result.content[0]?.text ?? ''
      if (result.isError) throw new Error(text)
      return JSON.parse(text) as Record<string, unknown>
    },
    end() {
      child.stdin.end()
      return exited
    },
    kill() {
      child.kill('SIGKILL')
    },
  }
}
