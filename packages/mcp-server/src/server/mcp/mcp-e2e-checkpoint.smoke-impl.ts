import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { messageOf } from '@kamiazya/whiteboard-model'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'

/** Workspace path used for every canvas the smoke creates. */
const WORKSPACE_ID = 'e2e'

interface RunOptions {
  /** Absolute path to the MCP server entry point (.ts for dev, .js for packaged). */
  entry: string
  /** Package root used as cwd for the spawned child process. */
  root: string
  /**
   * Ambient environment to spread into the spawned child. Defaults to
   * process.env; callers that must not forward an ambient flag (e.g. the
   * packaged tarball smoke excluding WHITEBOARD_DEV) pass a filtered copy.
   */
  env?: NodeJS.ProcessEnv
}

type RpcResponse = {
  content?: Array<{ type: string; text: string }>
  isError?: boolean
}

/**
 * Builds the child process env, preserving every inherited var from the
 * parent process while pointing the child at an isolated data dir. Pure so
 * env propagation is unit-testable without spawning a real process.
 */
export function buildCheckpointChildEnv(
  processEnv: NodeJS.ProcessEnv,
  dataDir: string,
): NodeJS.ProcessEnv {
  return { ...processEnv, WHITEBOARD_DATA_DIR: dataDir }
}

/** The first tool call that touches storage: a `wb_workspace_edit` `document.create`. */
function createFirstDocument(
  callTool: (name: string, args: unknown) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  return callTool('wb_workspace_edit', {
    workspaceId: WORKSPACE_ID,
    createWorkspace: true,
    ops: [
      {
        op: 'document.create',
        path: 'e2e-src',
        // markdown, because the flow below sets a facet on it — facets are
        // OKF frontmatter, and nothing here needs a spatial canvas: version
        // save/list/restore is about history, not content shape.
        kind: 'markdown',
      },
    ],
  })
}

/**
 * A `document.move` through the same tool, answering the path it reports.
 * The SDK validates `structuredContent` against `outputSchema`, so this is
 * where a result row the schema cannot describe would surface.
 */
async function moveFirstDocument(
  callTool: (name: string, args: unknown) => Promise<Record<string, unknown>>,
  documentId: string,
): Promise<string> {
  const moved = await callTool('wb_workspace_edit', {
    workspaceId: WORKSPACE_ID,
    ops: [{ op: 'document.move', documentId, path: 'e2e/src' }],
  })
  const row = (moved.results as { documentId?: unknown; path?: unknown }[] | undefined)?.[0]
  if (row?.documentId !== documentId || row.path !== 'e2e/src') {
    throw new Error(`document.move returned unexpected shape: ${JSON.stringify(moved)}`)
  }
  return row.path
}

/**
 * A JSON-RPC client over the child's stdio pipes: newline-framed requests
 * out, newline-framed responses correlated back by id.
 *
 * The timeout is generous and configurable because the FIRST `tools/call`
 * spawns the packaged daemon, so its latency includes the full cold start.
 * CI runners exceed the 20s default, and the env override lets the release
 * publish jobs wait longer without slowing local runs.
 */
function jsonRpcOverStdio(child: ChildProcess): {
  rpc: (method: string, params: unknown) => Promise<unknown>
  notify: (method: string, params: unknown) => void
} {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let stdoutBuf = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString()
    for (let idx = stdoutBuf.indexOf('\n'); idx !== -1; idx = stdoutBuf.indexOf('\n')) {
      const line = stdoutBuf.slice(0, idx)
      stdoutBuf = stdoutBuf.slice(idx + 1)
      settleRpcLine(line, pending)
    }
  })

  const rpcTimeoutMs = /^\d+$/.test(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS ?? '')
    ? Number(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS)
    : 20_000
  let nextId = 1

  return {
    rpc(method: string, params: unknown): Promise<unknown> {
      const id = nextId++
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        })
        child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error(`RPC ${method} (#${id}) timed out`))
          }
        }, rpcTimeoutMs)
      })
    },
    notify(method: string, params: unknown): void {
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
  }
}

/**
 * Settle the waiter for one framed line, if it is a response to a request
 * still in flight. Anything else — a blank line, a non-JSON line, a
 * notification, a response to an id nobody is waiting on — is ignored: the
 * child's stdout is a stream this client does not own exclusively.
 */
function settleRpcLine(
  line: string,
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>,
): void {
  if (!line.trim()) return
  let msg: { id?: number; error?: unknown; result?: unknown }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id == null || !pending.has(msg.id)) return
  const { resolve, reject } = pending.get(msg.id)!
  pending.delete(msg.id)
  if (msg.error) reject(new Error(`RPC ${msg.id}: ${JSON.stringify(msg.error)}`))
  else resolve(msg.result)
}

/**
 * The live `tools/list` must hold the version tools, and its name SET must
 * equal `ALL_REGISTERED_TOOLS` in mcp-smoke-coverage.ts.
 *
 * A set comparison rather than a count: a rename plus an addition keeps the
 * count identical, and both directions of the difference are reported so one
 * run is enough to fix the classification.
 */
function assertToolSurface(names: readonly string[]): void {
  const required = ['wb_version_save', 'wb_version_restore', 'wb_version_list']
  const missing = required.filter((n) => !names.includes(n))
  if (missing.length > 0) {
    throw new Error(`version tools missing from tools/list: ${names.join(', ')}`)
  }

  const liveSet = new Set(names)
  const classifiedSet = new Set(ALL_REGISTERED_TOOLS)
  const inLiveNotClassified = names.filter((n) => !classifiedSet.has(n))
  const inClassifiedNotLive = ALL_REGISTERED_TOOLS.filter((n) => !liveSet.has(n))
  if (inLiveNotClassified.length === 0 && inClassifiedNotLive.length === 0) return

  const lines = ['tools/list does not match ALL_REGISTERED_TOOLS in mcp-smoke-coverage.ts.']
  if (inLiveNotClassified.length > 0) {
    lines.push(`  In tools/list but not classified: ${inLiveNotClassified.join(', ')}`)
  }
  if (inClassifiedNotLive.length > 0) {
    lines.push(`  In classification but not in tools/list: ${inClassifiedNotLive.join(', ')}`)
  }
  lines.push(
    '  Update ALL_REGISTERED_TOOLS and one of the four category arrays in mcp-smoke-coverage.ts.',
  )
  throw new Error(lines.join('\n'))
}

type CallTool = (name: string, args: unknown) => Promise<Record<string, unknown>>

/**
 * Save a version, find it in the listing, and restore it — the checkpoint
 * this smoke exists to prove works through the PACKAGED artifact, where a
 * schema-versus-runtime drift the type system cannot see would surface.
 */
async function exerciseVersionRoundTrip(callTool: CallTool, documentId: string): Promise<void> {
  const saved = await callTool('wb_version_save', {
    workspaceId: WORKSPACE_ID,
    documentIds: [documentId],
    label: 'e2e-version-1',
  })
  const savedRow = (
    saved.saved as
      | Array<{ documentId?: string; version?: { id?: string; label?: string; auto?: boolean } }>
      | undefined
  )?.[0]
  const savedVersion = savedRow?.version
  if (
    savedRow?.documentId !== documentId ||
    !savedVersion?.id ||
    savedVersion.label !== 'e2e-version-1' ||
    savedVersion.auto !== false
  ) {
    throw new Error(`wb_version_save returned unexpected shape: ${JSON.stringify(saved)}`)
  }
  console.log(`[e2e] wb_version_save → ${savedVersion.id}`)

  const versions = await callTool('wb_version_list', { workspaceId: WORKSPACE_ID, documentId })
  if (versions.documentId !== documentId || !Array.isArray(versions.versions)) {
    throw new Error(`wb_version_list returned unexpected shape: ${JSON.stringify(versions)}`)
  }
  const versionEntries = versions.versions as Array<{ id: string }>
  if (!versionEntries.some((v) => v.id === savedVersion.id)) {
    throw new Error(`wb_version_list missing saved version id: ${JSON.stringify(versions)}`)
  }
  console.log(`[e2e] wb_version_list → ${versionEntries.length} version(s)`)

  const restored = await callTool('wb_version_restore', {
    workspaceId: WORKSPACE_ID,
    documentId,
    versionId: savedVersion.id,
  })
  if (
    restored.documentId !== documentId ||
    restored.restoredVersionId !== savedVersion.id ||
    restored.label !== savedVersion.label
  ) {
    throw new Error(`wb_version_restore returned unexpected shape: ${JSON.stringify(restored)}`)
  }
  console.log(`[e2e] wb_version_restore → ${restored.restoredVersionId}`)
}

export async function runE2eCheckpointSmoke({
  entry,
  root,
  env: ambientEnv = process.env,
}: RunOptions): Promise<void> {
  const tmpDataDir = mkdtempSync(join(tmpdir(), 'whiteboard-e2e-'))
  const childArgs = entry.endsWith('.ts') ? ['--import', 'tsx/esm', entry] : [entry]

  const child = spawn('node', childArgs, {
    cwd: root,
    env: buildCheckpointChildEnv(ambientEnv, tmpDataDir),
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stderrBuf = ''
  child.stderr!.on('data', (c: Buffer) => {
    stderrBuf += c.toString()
  })

  const { rpc, notify } = jsonRpcOverStdio(child)

  async function callTool(name: string, args: unknown): Promise<Record<string, unknown>> {
    const res = (await rpc('tools/call', { name, arguments: args })) as RpcResponse | null
    if (!res || !Array.isArray(res.content) || res.content[0]?.type !== 'text') {
      throw new Error(`unexpected tool/call result shape: ${JSON.stringify(res)}`)
    }
    const text = res.content[0].text
    if (res.isError) throw new Error(text)
    return JSON.parse(text) as Record<string, unknown>
  }

  // Kill child and clean up tmp dir on forced process exit (e.g. SIGINT in CLI wrapper).
  const exitHandler = () => {
    try {
      child.kill('SIGTERM')
    } catch {}
    rmSync(tmpDataDir, { recursive: true, force: true })
  }
  process.once('exit', exitHandler)

  try {
    console.log(`[e2e] entry → ${entry}`)
    console.log(`[e2e] spawn → node ${childArgs.join(' ')} (dataDir=${tmpDataDir})`)

    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-smoke', version: '0.0.0' },
    })
    notify('notifications/initialized', {})

    const toolsResult = (await rpc('tools/list', {})) as { tools: Array<{ name: string }> }
    assertToolSurface(toolsResult.tools.map((t) => t.name))

    const batch = await createFirstDocument(callTool)
    const created = (batch.results as { documentId?: unknown; path?: unknown }[] | undefined)?.[0]
    if (typeof created?.documentId !== 'string' || created.path !== 'e2e-src') {
      throw new Error(`wb_workspace_edit returned unexpected shape: ${JSON.stringify(batch)}`)
    }
    const documentId = created.documentId
    console.log(`[e2e] document.create → ${documentId}`)

    console.log(`[e2e] document.move → ${await moveFirstDocument(callTool, documentId)}`)

    // wb_facet_set seeds extension-facet state on the created document so the
    // version saved below has content to round-trip through restore.
    const facets = await callTool('wb_facet_set', {
      workspaceId: WORKSPACE_ID,
      documentIds: [documentId],
      facets: { 'e2e.check/v1': { note: 'before-save' } },
    })
    const updatedFacets = facets.updated as Array<{ documentId?: string }> | undefined
    if (updatedFacets?.[0]?.documentId !== documentId) {
      throw new Error(`wb_facet_set returned unexpected shape: ${JSON.stringify(facets)}`)
    }
    console.log('[e2e] wb_facet_set → seeded canvas state')

    await exerciseVersionRoundTrip(callTool, documentId)

    console.log('\n[e2e] ALL OK')
  } catch (err) {
    const msg = messageOf(err, String(err))
    const detail = stderrBuf ? `\n--- MCP stderr ---\n${stderrBuf}\n--- end ---` : ''
    throw new Error(`${msg}${detail}`)
  } finally {
    process.removeListener('exit', exitHandler)
    try {
      child.kill('SIGTERM')
    } catch {}
    rmSync(tmpDataDir, { recursive: true, force: true })
  }
}
