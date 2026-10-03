import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { watchChild } from './child-watch.mjs'

/**
 * One server process over `dataDir`, driven to the end of a session.
 *
 * Separate from the shared `child` because this phase's subject is what
 * happens when the process ENDS and a new one reads the same directory:
 * automatic history rows are taken at the pause or at session end, so they
 * are only observable across a restart.
 */
async function startSession({ childArgs, root, rpcTimeoutMs }, dataDir) {
  const proc = spawn('node', childArgs, {
    cwd: root,
    env: { ...process.env, WHITEBOARD_DATA_DIR: dataDir, WHITEBOARD_NO_WATCH: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const waiting = new Map()
  const watched = watchChild(proc, waiting)
  let buffered = ''
  proc.stdout.on('data', (chunk) => {
    buffered += chunk.toString()
    for (let idx = buffered.indexOf('\n'); idx !== -1; idx = buffered.indexOf('\n')) {
      const line = buffered.slice(0, idx)
      buffered = buffered.slice(idx + 1)
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const settle = waiting.get(msg.id)
      if (settle === undefined) continue
      waiting.delete(msg.id)
      if (msg.error) settle.reject(new Error(`RPC ${msg.id}: ${JSON.stringify(msg.error)}`))
      else settle.resolve(msg.result)
    }
  })
  let id = 0
  const send = (method, params) =>
    new Promise((resolveRpc, reject) => {
      if (watched.ended()) return reject(watched.ended())
      const mine = ++id
      waiting.set(mine, { resolve: resolveRpc, reject })
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`)
      setTimeout(() => {
        if (waiting.delete(mine)) reject(new Error(`RPC ${method} (#${mine}) timed out`))
      }, rpcTimeoutMs)
    })
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-smoke-session', version: '0.0.0' },
  })
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  return {
    async call(name, args) {
      const res = await send('tools/call', { name, arguments: args })
      const text = res?.content?.[0]?.text
      if (res?.isError) throw new Error(text)
      return JSON.parse(text)
    },
    /** Closing stdin is how a client ends the session; the server flushes what it holds pending. */
    async end() {
      const exited = new Promise((resolveExit) => proc.once('exit', resolveExit))
      proc.stdin.end()
      const timer = setTimeout(() => proc.kill('SIGTERM'), rpcTimeoutMs)
      await exited
      clearTimeout(timer)
      return watched.stderr()
    },
    kill: () => proc.kill('SIGTERM'),
  }
}

export async function anAutomaticCheckpointFollowsAMoveOrDelete(server) {
  const dataDir = mkdtempSync(`${tmpdir()}/whiteboard-e2e-session-`)
  let session = await startSession(server, dataDir)
  try {
    const workspaceId = 'e2e-moves'
    const created = await session.call('wb_workspace_edit', {
      workspaceId,
      createWorkspace: true,
      ops: [
        { op: 'document.create', path: 'moved', kind: 'spatial' },
        { op: 'document.create', path: 'control', kind: 'spatial' },
        { op: 'document.create', path: 'deleted', kind: 'spatial' },
      ],
    })
    const [moved, control, deleted] = created.results.map((result) => result.documentId)
    await Promise.all(
      [moved, control, deleted].map((documentId) =>
        session.call('wb_canvas_edit', {
          workspaceId,
          documentId,
          mode: 'apply',
          ops: [
            {
              op: 'node.add',
              node: { id: 'n1', type: 'text', x: 0, y: 0, width: 120, height: 40, text: 'hi' },
            },
          ],
        }),
      ),
    )
    await session.call('wb_workspace_edit', {
      workspaceId,
      ops: [
        { op: 'document.move', documentId: moved, path: 'moved-2' },
        { op: 'document.delete', documentId: deleted },
      ],
    })
    const stderr = await session.end()
    if (stderr.includes('auto-version')) {
      throw new Error(`the session end logged an auto-version failure:\n${stderr}`)
    }

    session = await startSession(server, dataDir)
    const histories = await Promise.all(
      [
        ['the moved document', moved],
        ['the untouched control', control],
      ].map(async ([label, documentId]) => ({
        label,
        listed: await session.call('wb_version_list', { workspaceId, documentId }),
      })),
    )
    for (const { label, listed } of histories) {
      if (!Array.isArray(listed.versions) || listed.versions.length === 0) {
        throw new Error(`${label} has no automatic history row: ${JSON.stringify(listed)}`)
      }
    }
    console.log(
      '[e2e] session end → the moved document keeps its automatic checkpoint, and a deleted one logs no failure',
    )
  } finally {
    session.kill()
    rmSync(dataDir, { recursive: true, force: true })
  }
}
