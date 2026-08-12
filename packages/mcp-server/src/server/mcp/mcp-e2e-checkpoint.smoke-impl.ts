import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { retryDaemonStartup } from './daemon-readiness.js'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'

/** Workspace slug used for every canvas the smoke creates. */
const WORKSPACE_ID = 'e2e'

interface RunOptions {
  /** Absolute path to the MCP server entry point (.ts for dev, .js for packaged). */
  entry: string
  /** Package root used as cwd for the spawned child process. */
  root: string
  /**
   * Opt-in: retry the daemon-triggering RPC across bounded cold-start
   * windows instead of failing on the first "Daemon startup timeout".
   * Defaults to false so callers running under a fixed vitest testTimeout
   * (mcp-e2e-checkpoint.smoke.test.ts) keep exact single-window semantics.
   */
  retryDaemonStartup?: boolean
  /** Extra RPC attempts beyond the first when retryDaemonStartup is set. */
  maxDaemonStartupRetries?: number
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
 * Builds the child process env, preserving WHITEBOARD_DAEMON_STARTUP_TIMEOUT_MS
 * (and any other inherited var) from the parent process while pointing the
 * child at an isolated data dir. Pure so env propagation is unit-testable
 * without spawning a real process.
 */
export function buildCheckpointChildEnv(
  processEnv: NodeJS.ProcessEnv,
  dataDir: string,
): NodeJS.ProcessEnv {
  return { ...processEnv, WHITEBOARD_DATA_DIR: dataDir }
}

/**
 * Issues the first daemon-triggering tool call (wb_document_create), optionally
 * retried across bounded cold-start windows via retryDaemonStartup. Extracted
 * so the retry wiring is unit-testable against a fake callTool without spawning
 * a real MCP child process.
 */
export function triggerDaemonCanvasCreate(
  callTool: (name: string, args: unknown) => Promise<Record<string, unknown>>,
  options: { retryDaemonStartup: boolean; maxDaemonStartupRetries: number },
): Promise<Record<string, unknown>> {
  const attempt = () =>
    callTool('wb_document_create', {
      workspaceId: WORKSPACE_ID,
      segment: 'e2e-src',
      kind: 'spatial',
      createWorkspace: true,
    })
  return options.retryDaemonStartup
    ? retryDaemonStartup({ attempt, maxRetries: options.maxDaemonStartupRetries })
    : attempt()
}

/**
 * Reads every daemon-*.log file under <dataDir>/logs, which is where
 * ensureDaemon (see ensure-daemon.ts openDaemonLogFile) redirects the
 * detached daemon child's stdout/stderr. The caller's tmp data dir is
 * deleted right after this smoke fails, so a "Daemon startup timeout"
 * would otherwise discard the one artifact that explains why the daemon
 * process never bound its port (crash on require, missing devDependency
 * when run against an installed-only tree, etc.). Best-effort: absent or
 * unreadable logs must never mask the original failure.
 */
export async function readDaemonLogsForFailure(dataDir: string): Promise<string> {
  try {
    const logsDir = join(dataDir, 'logs')
    const files = (await readdir(logsDir)).filter(
      (f) => f.startsWith('daemon-') && f.endsWith('.log'),
    )
    if (files.length === 0) return ''
    const contents = await Promise.all(
      files.map(async (f) => {
        const body = await readFile(join(logsDir, f), 'utf-8')
        return `--- ${f} ---\n${body.trim()}`
      }),
    )
    return `\n--- daemon log(s) ---\n${contents.join('\n')}\n--- end daemon log(s) ---`
  } catch {
    return ''
  }
}

export async function runE2eCheckpointSmoke({
  entry,
  root,
  retryDaemonStartup: shouldRetryDaemonStartup = false,
  maxDaemonStartupRetries = 1,
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

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let stdoutBuf = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString()
    for (let idx = stdoutBuf.indexOf('\n'); idx !== -1; idx = stdoutBuf.indexOf('\n')) {
      const line = stdoutBuf.slice(0, idx)
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line.trim()) continue
      let msg: { id?: number; error?: unknown; result?: unknown }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) reject(new Error(`RPC ${msg.id}: ${JSON.stringify(msg.error)}`))
        else resolve(msg.result)
      }
    }
  })

  // The first tools/call spawns the packaged daemon, so its latency includes the
  // full cold-start. CI runners exceed the 20s default; the env override lets the
  // release publish jobs wait longer without slowing local runs.
  const rpcTimeoutMs = /^\d+$/.test(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS ?? '')
    ? Number(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS)
    : 20_000

  let nextId = 1

  function rpc(method: string, params: unknown): Promise<unknown> {
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
  }

  function notify(method: string, params: unknown): void {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

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
    const names = toolsResult.tools.map((t) => t.name)
    if (
      !names.includes('wb_version_save') ||
      !names.includes('wb_version_restore') ||
      !names.includes('wb_version_list')
    ) {
      throw new Error(`version tools missing from tools/list: ${names.join(', ')}`)
    }
    // Guard: tools/list name set must equal ALL_REGISTERED_TOOLS in mcp-smoke-coverage.ts.
    // Set comparison catches renames and additions/deletions that a count check would miss.
    {
      const liveSet = new Set(names)
      const classifiedSet = new Set(ALL_REGISTERED_TOOLS)
      const inLiveNotClassified = names.filter((n) => !classifiedSet.has(n))
      const inClassifiedNotLive = ALL_REGISTERED_TOOLS.filter((n) => !liveSet.has(n))
      if (inLiveNotClassified.length > 0 || inClassifiedNotLive.length > 0) {
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
    }

    // wb_document_create is the first daemon-dependent RPC, so its failure mode is
    // the daemon cold-starting under contention. Retrying is opt-in: only the
    // tarball smoke (no fixed vitest testTimeout) enables it.
    const created = await triggerDaemonCanvasCreate(callTool, {
      retryDaemonStartup: shouldRetryDaemonStartup,
      maxDaemonStartupRetries,
    })
    if (typeof created.canvasId !== 'string' || created.segment !== 'e2e-src') {
      throw new Error(`wb_document_create returned unexpected shape: ${JSON.stringify(created)}`)
    }
    const canvasId = created.canvasId
    console.log(`[e2e] wb_document_create → ${canvasId}`)

    // wb_facet_set seeds extension-facet state on the created canvas so the version
    // saved below has content to round-trip through restore.
    const facets = await callTool('wb_facet_set', {
      workspaceId: WORKSPACE_ID,
      canvasId,
      facets: { 'e2e/1': { note: 'before-save' } },
    })
    if (facets.canvasId !== canvasId) {
      throw new Error(`wb_facet_set returned unexpected shape: ${JSON.stringify(facets)}`)
    }
    console.log('[e2e] wb_facet_set → seeded canvas state')

    const saved = await callTool('wb_version_save', {
      canvasId,
      label: 'e2e-version-1',
    })
    if (
      !saved.versionId ||
      saved.canvasId !== canvasId ||
      saved.label !== 'e2e-version-1' ||
      !saved.timestamp ||
      !saved.frontier
    ) {
      throw new Error(`wb_version_save returned unexpected shape: ${JSON.stringify(saved)}`)
    }
    console.log(`[e2e] wb_version_save → ${saved.versionId}`)

    const versions = await callTool('wb_version_list', { canvasId })
    if (versions.canvasId !== canvasId || !Array.isArray(versions.versions)) {
      throw new Error(`wb_version_list returned unexpected shape: ${JSON.stringify(versions)}`)
    }
    const versionEntries = versions.versions as Array<{ versionId: string }>
    if (!versionEntries.some((v) => v.versionId === saved.versionId)) {
      throw new Error(`wb_version_list missing saved versionId: ${JSON.stringify(versions)}`)
    }
    console.log(`[e2e] wb_version_list → ${versionEntries.length} version(s)`)

    const restored = await callTool('wb_version_restore', {
      workspaceId: WORKSPACE_ID,
      canvasId,
      versionId: saved.versionId,
    })
    if (
      restored.canvasId !== canvasId ||
      restored.restoredVersionId !== saved.versionId ||
      restored.label !== saved.label ||
      restored.frontier !== saved.frontier
    ) {
      throw new Error(`wb_version_restore returned unexpected shape: ${JSON.stringify(restored)}`)
    }
    console.log(`[e2e] wb_version_restore → ${restored.restoredVersionId}`)

    console.log('\n[e2e] ALL OK')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const detail = stderrBuf ? `\n--- MCP stderr ---\n${stderrBuf}\n--- end ---` : ''
    // Read before `finally` deletes tmpDataDir, so a startup failure still
    // surfaces why the detached daemon process never bound its port.
    const daemonLogDetail = await readDaemonLogsForFailure(tmpDataDir)
    throw new Error(`${msg}${detail}${daemonLogDetail}`)
  } finally {
    process.removeListener('exit', exitHandler)
    try {
      child.kill('SIGTERM')
    } catch {}
    rmSync(tmpDataDir, { recursive: true, force: true })
  }
}
