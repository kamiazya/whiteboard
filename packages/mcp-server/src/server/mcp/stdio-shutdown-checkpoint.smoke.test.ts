import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const entry = resolve(root, 'src/server/mcp/stdio.ts')

/**
 * Two real stdio processes over one data dir. The first writes as an agent
 * and goes away before the five-minute quiet window ends; the second reads
 * the history it left. The process-level wiring (`main()` arming the
 * checkpoint, and its shutdown taking the pending one) is exactly what a unit
 * test over the declaration cannot see.
 */
interface Session {
  call(name: string, args: unknown): Promise<Record<string, unknown>>
  /** Closes stdin, as a client disconnecting does, and resolves with the exit code. */
  end(): Promise<number | null>
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

async function openSession(dataDir: string): Promise<Session> {
  const child: ChildProcessWithoutNullStreams = spawn('node', ['--import', 'tsx/esm', entry], {
    cwd: root,
    env: { ...process.env, WHITEBOARD_DATA_DIR: dataDir, WHITEBOARD_NO_WATCH: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
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
    clientInfo: { name: 'shutdown-checkpoint-smoke', version: '0.0.0' },
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
  }
}

const children: ChildProcessWithoutNullStreams[] = []
let dataDir = ''

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('stdio shutdown checkpoint smoke', () => {
  it('leaves an automatic version behind when an agent-only session ends', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-stdio-shutdown-'))

    const first = await openSession(dataDir)
    const batch = await first.call('wb_workspace_edit', {
      workspaceId: 'agent-only',
      createWorkspace: true,
      ops: [{ op: 'document.create', path: 'notes', kind: 'markdown' }],
    })
    const workspaceId = batch.workspaceId as string
    const documentId = (batch.results as { documentId: string }[])[0]?.documentId as string
    await first.call('wb_facet_set', {
      workspaceId,
      documentIds: [documentId],
      facets: { 'smoke.check/v1': { note: 'written by an agent' } },
    })
    expect(await first.end()).toBe(0)

    const second = await openSession(dataDir)
    const listed = await second.call('wb_version_list', { workspaceId, documentId })
    expect(listed.versions).toEqual([expect.objectContaining({ auto: true })])
  }, 60_000)
})
