import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { retryDaemonStartup } from './daemon-readiness.js'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'

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
 * Issues the daemon-triggering canvas_create call, optionally retried across
 * bounded cold-start windows via retryDaemonStartup. Extracted so the retry
 * wiring is unit-testable against a fake callTool without spawning a real
 * MCP child process.
 */
export function triggerDaemonCanvasCreate(
  callTool: (name: string, args: unknown) => Promise<Record<string, unknown>>,
  options: { retryDaemonStartup: boolean; maxDaemonStartupRetries: number },
): Promise<Record<string, unknown>> {
  const attempt = () => callTool('canvas_create', { slug: 'e2e-src' })
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
    let idx: number
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
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
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`RPC ${method} (#${id}) timed out`))
        }
      }, rpcTimeoutMs)
    })
  }

  function notify(method: string, params: unknown): void {
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
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

  async function expectRejected(
    promise: Promise<unknown>,
    pattern: RegExp,
    label: string,
  ): Promise<void> {
    try {
      await promise
    } catch (err) {
      if (err instanceof Error && pattern.test(err.message)) return
      throw new Error(`${label}: wrong error: ${err instanceof Error ? err.message : String(err)}`)
    }
    throw new Error(`${label}: expected rejection but resolved`)
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
      !names.includes('version_save') ||
      !names.includes('version_restore') ||
      !names.includes('version_list')
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

    // canvas_create is the first daemon-dependent RPC, so its failure mode is
    // the daemon cold-starting under contention. Retrying is opt-in: only the
    // tarball smoke (no fixed vitest testTimeout) enables it.
    const created = await triggerDaemonCanvasCreate(callTool, {
      retryDaemonStartup: shouldRetryDaemonStartup,
      maxDaemonStartupRetries,
    })
    if (!created.id || !created.url) throw new Error(`canvas_create returned unexpected shape`)
    console.log(`[e2e] canvas_create → ${created.id}`)

    const workspaceId = (created.id as string).split('/')[0]

    const listed = await callTool('canvas_list', {})
    if (!Array.isArray(listed.workspaces)) {
      throw new Error(`canvas_list returned unexpected shape: ${JSON.stringify(listed)}`)
    }
    const totalCanvases = (listed.workspaces as Array<{ canvases: unknown[] }>).reduce(
      (n, ws) => n + (Array.isArray(ws.canvases) ? ws.canvases.length : 0),
      0,
    )
    console.log(
      `[e2e] canvas_list → ${(listed.workspaces as unknown[]).length} workspaces, ${totalCanvases} canvases`,
    )

    const palette = await callTool('palette_get', { workspaceId })
    if (typeof palette.palette !== 'object' || palette.palette === null) {
      throw new Error(`palette_get returned unexpected shape: ${JSON.stringify(palette)}`)
    }
    console.log('[e2e] palette_get → OK')

    const libsInstalled = await callTool('library_list_installed', {})
    if (!Array.isArray(libsInstalled.installedUrls)) {
      throw new Error(
        `library_list_installed returned unexpected shape: ${JSON.stringify(libsInstalled)}`,
      )
    }
    console.log(
      `[e2e] library_list_installed → ${(libsInstalled.installedUrls as unknown[]).length} urls`,
    )

    // library_uninstall with a never-installed URL. removeInstalledLibrary is an idempotent SQL DELETE
    // that returns the current installed list, so this succeeds offline without any HTTPS fetch.
    const libUninstalled = await callTool('library_uninstall', {
      libraryUrl: 'https://smoke-test.example.com/never-installed.excalidrawlib',
    })
    if (!Array.isArray(libUninstalled.installedUrls)) {
      throw new Error(
        `library_uninstall returned unexpected shape: ${JSON.stringify(libUninstalled)}`,
      )
    }
    console.log('[e2e] library_uninstall (idempotent) → OK')

    // library_list_items with a local fixture file — no HTTPS fetch required.
    const libFixturePath = join(tmpDataDir, 'e2e-smoke.excalidrawlib')
    await writeFile(
      libFixturePath,
      JSON.stringify({
        type: 'excalidrawlib',
        version: 2,
        libraryItems: [
          {
            id: 'smoke-item-1',
            name: 'smoke-rect',
            elements: [{ id: 'se-1', type: 'rectangle', x: 0, y: 0, width: 40, height: 40 }],
          },
        ],
      }),
    )
    const libItems = await callTool('library_list_items', { libraryPath: libFixturePath })
    if ((libItems.itemCount as number) !== 1) {
      throw new Error(`library_list_items returned unexpected shape: ${JSON.stringify(libItems)}`)
    }
    console.log(`[e2e] library_list_items (libraryPath) → ${libItems.itemCount} items`)

    const ann = await callTool('annotate', {
      canvasId: created.id,
      type: 'rectangle',
      target: { x: 10, y: 20 },
      coords: 'absolute',
      width: 80,
      height: 40,
      color: '#1971c2',
    })
    if (!ann.elementId && !ann.elementIds) {
      throw new Error(`annotate returned unexpected shape: ${JSON.stringify(ann)}`)
    }
    console.log(`[e2e] annotate → rect`)

    // Exercise create_frame so any drift between its zod outputSchema
    // (assignedMembers etc.) and the runtime payload trips the SDK's structured-
    // content validator at this layer instead of leaking out to MCP clients.
    const rectId = (ann.elementId ?? (ann.elementIds as string[] | undefined)?.[0]) as
      | string
      | undefined
    if (!rectId) throw new Error('annotate returned no rectangle id to seed create_frame')
    const frame = await callTool('create_frame', {
      canvasId: created.id,
      name: 'e2e-frame',
      memberIds: [rectId],
    })
    if (!frame.elementId || !Array.isArray(frame.assignedMembers)) {
      throw new Error(`create_frame returned unexpected shape: ${JSON.stringify(frame)}`)
    }
    console.log(
      `[e2e] create_frame → ${frame.elementId} (${(frame.assignedMembers as unknown[]).length} members)`,
    )

    const insBefore = await callTool('canvas_inspect', { canvasId: created.id })
    if ((insBefore.elementCount as number) < 1) {
      throw new Error(`source canvas missing element: ${JSON.stringify(insBefore)}`)
    }

    const saved = await callTool('version_save', { canvasId: created.id })
    if (!saved.versionId) throw new Error('version_save returned no id')
    if (saved.elementCount !== insBefore.elementCount) {
      throw new Error(
        `element count mismatch: save=${saved.elementCount} inspect=${insBefore.elementCount}`,
      )
    }
    console.log(`[e2e] version_save → ${saved.versionId} (${saved.elementCount} elems)`)

    const versions = await callTool('version_list', { canvasId: created.id })
    if (!Array.isArray(versions.versions) || (versions.versions as unknown[]).length < 1) {
      throw new Error(`version_list returned unexpected shape: ${JSON.stringify(versions)}`)
    }
    console.log(`[e2e] version_list → ${(versions.versions as unknown[]).length} versions`)

    const restored = await callTool('version_restore', {
      canvasId: created.id,
      versionId: saved.versionId,
      targetSlug: 'e2e-restored',
    })
    if (!(restored.canvasId as string).endsWith('/e2e-restored')) {
      throw new Error(`unexpected restore canvasId: ${restored.canvasId}`)
    }
    console.log(`[e2e] version_restore → ${restored.canvasId}`)

    const insAfter = await callTool('canvas_inspect', { canvasId: restored.canvasId })
    if (insAfter.elementCount !== insBefore.elementCount) {
      throw new Error(
        `restored elementCount ${insAfter.elementCount} ≠ original ${insBefore.elementCount}`,
      )
    }
    const types = ((insAfter.elements as Array<{ type: string }> | undefined) ?? []).map(
      (e) => e.type,
    )
    if (!types.includes('rectangle')) {
      throw new Error(`restored canvas missing rectangle: ${JSON.stringify(insAfter)}`)
    }
    console.log(
      `[e2e] canvas_inspect(restored) → ${insAfter.elementCount} elems, types=${types.join(',')}`,
    )

    await expectRejected(
      callTool('version_restore', {
        canvasId: created.id,
        versionId: saved.versionId,
        targetSlug: 'e2e-restored',
      }),
      /already exists/,
      'duplicate restore without overwrite',
    )

    await callTool('version_restore', {
      canvasId: created.id,
      versionId: saved.versionId,
      targetSlug: 'e2e-restored',
      overwrite: true,
    })
    console.log(`[e2e] version_restore overwrite=true OK`)

    console.log('[e2e] version_save / version_restore / version_list all OK')

    await expectRejected(
      callTool('viewport_set', { canvasId: created.id, mode: 'fit' }),
      /No browser client/i,
      'viewport_set without browser client',
    )
    console.log('[e2e] viewport_set → no_client OK (route wiring verified)')

    // A frame whose bounding box is disjoint from the rectangle drawn above
    // (x:10 y:20 w:80 h:40), so a frameId-scoped export can be distinguished
    // from a full-canvas export by the rectangle's stroke color (#1971c2)
    // being absent from the scoped output.
    const emptyFrame = await callTool('create_frame', {
      canvasId: created.id,
      x: 500,
      y: 500,
      width: 100,
      height: 100,
      name: 'e2e-empty-frame',
    })
    if (!emptyFrame.elementId) {
      throw new Error(`create_frame returned unexpected shape: ${JSON.stringify(emptyFrame)}`)
    }
    console.log(`[e2e] create_frame → ${emptyFrame.elementId}`)

    const readSvgMarkup = async (result: Record<string, unknown>): Promise<string> =>
      typeof result.svgMarkup === 'string'
        ? result.svgMarkup
        : await readFile(result.filePath as string, 'utf-8')

    // export_canvas(format:'svg') delegates in-process to exportSvgTool().execute(),
    // bypassing the registered export_svg tool's own registerToolWithAnnotations
    // binding and structuredContent validation entirely. Call export_svg directly
    // too so a drift confined to that standalone registration wrapper (as opposed
    // to the shared execute() body) is still caught here. Exercise every optional
    // field the wrapper destructures and forwards
    // (packages/mcp-server/src/server/mcp/tool-registration.ts) and assert an
    // effect specific to each one, so dropping any single field from that
    // forwarding list turns this red rather than staying green:
    //  - outputPath: returned filePath matches the requested path
    //  - theme: rendered background switches to the dark default (#121212)
    //  - frameId: scoping to the empty frame excludes the rectangle (#1971c2)
    const svgOutputPath = join(tmpDataDir, workspaceId, 'exports', 'e2e-direct.svg')
    const svgDirect = await callTool('export_svg', {
      canvasId: created.id,
      outputPath: svgOutputPath,
      theme: 'dark',
      frameId: emptyFrame.elementId,
      padding: 5,
    })
    if (svgDirect.filePath !== svgOutputPath) {
      throw new Error(
        `export_svg ignored outputPath: expected ${svgOutputPath}, got ${JSON.stringify(svgDirect)}`,
      )
    }
    const svgDirectMarkup = await readSvgMarkup(svgDirect)
    if (!svgDirectMarkup.trim().startsWith('<svg')) {
      throw new Error('export_svg did not produce real SVG markup')
    }
    if (!svgDirectMarkup.includes('#121212')) {
      throw new Error(`export_svg ignored theme: expected dark background in ${svgDirectMarkup}`)
    }
    if (svgDirectMarkup.includes('#1971c2')) {
      throw new Error(
        'export_svg ignored frameId: scoping to the empty frame should exclude the rectangle',
      )
    }
    console.log('[e2e] export_svg (direct, outputPath+theme+frameId forwarded) OK')

    // padding: re-export the same frame-scoped canvas with a much larger
    // padding and assert the viewBox actually widened, so dropping `padding`
    // from the forwarding list (which would silently fall back to the
    // default) also turns this red.
    const svgWidePadding = await callTool('export_svg', {
      canvasId: created.id,
      frameId: emptyFrame.elementId,
      padding: 300,
    })
    const svgWidePaddingMarkup = await readSvgMarkup(svgWidePadding)
    const extractViewBoxWidth = (markup: string): number => {
      const match = markup.match(/viewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+[-\d.]+"/)
      if (!match) throw new Error(`export_svg output missing viewBox: ${markup.slice(0, 200)}`)
      return Number.parseFloat(match[1])
    }
    if (extractViewBoxWidth(svgWidePaddingMarkup) <= extractViewBoxWidth(svgDirectMarkup)) {
      throw new Error('export_svg ignored padding: a wider padding did not widen the viewBox')
    }
    console.log('[e2e] export_svg padding forwarded (viewBox widened) OK')

    // overwrite: without it, re-exporting to the same outputPath must be
    // rejected; with it, the same call must succeed.
    await expectRejected(
      callTool('export_svg', { canvasId: created.id, outputPath: svgOutputPath }),
      /already exists/,
      'export_svg duplicate outputPath without overwrite',
    )
    await callTool('export_svg', {
      canvasId: created.id,
      outputPath: svgOutputPath,
      overwrite: true,
    })
    console.log('[e2e] export_svg overwrite forwarded OK')

    // export_canvas unifies png/svg/json behind one tool — exercise all three
    // formats so structuredContent validation against each format's branch of
    // exportCanvasOutputSchema runs at least once. PNG also falls back to
    // headless rendering when no browser is connected, so this doubles as the
    // no-client-headless-render regression check.
    const canvasPng = await callTool('export_canvas', { canvasId: created.id, format: 'png' })
    if (canvasPng.format !== 'png' || !canvasPng.filePath) {
      throw new Error(
        `export_canvas(format:png) returned unexpected shape: ${JSON.stringify(canvasPng)}`,
      )
    }
    console.log('[e2e] export_canvas(format:png) OK (headless render, no browser client)')

    const canvasSvg = await callTool('export_canvas', { canvasId: created.id, format: 'svg' })
    if (canvasSvg.format !== 'svg' || !(canvasSvg.filePath as string).endsWith('.svg')) {
      throw new Error(
        `export_canvas(format:svg) returned unexpected shape: ${JSON.stringify(canvasSvg)}`,
      )
    }
    const svgMarkup = await readFile(canvasSvg.filePath as string, 'utf-8')
    if (!svgMarkup.trim().startsWith('<svg')) {
      throw new Error('export_canvas(format:svg) did not produce real SVG markup')
    }
    console.log('[e2e] export_canvas(format:svg) OK (real <svg> markup on disk)')

    const canvasJson = await callTool('export_canvas', { canvasId: created.id, format: 'json' })
    if (canvasJson.format !== 'json' || !(canvasJson.filePath as string).endsWith('.excalidraw')) {
      throw new Error(
        `export_canvas(format:json) returned unexpected shape: ${JSON.stringify(canvasJson)}`,
      )
    }
    const exportedJsonBody = JSON.parse(await readFile(canvasJson.filePath as string, 'utf-8')) as {
      type: string
      version: number
      elements: Array<{ type: string }>
    }
    if (exportedJsonBody.type !== 'excalidraw' || exportedJsonBody.version !== 2) {
      throw new Error(
        `exported JSON has wrong wrapper: ${JSON.stringify({ type: exportedJsonBody.type, version: exportedJsonBody.version })}`,
      )
    }
    if (
      !Array.isArray(exportedJsonBody.elements) ||
      exportedJsonBody.elements.length !== canvasJson.elementCount
    ) {
      throw new Error(
        `element count mismatch: body.elements=${exportedJsonBody.elements?.length} elementCount=${canvasJson.elementCount}`,
      )
    }
    const rectInExport = exportedJsonBody.elements.find((el) => el.type === 'rectangle')
    if (!rectInExport) throw new Error('exported JSON missing rectangle we annotated earlier')
    console.log(
      `[e2e] export_canvas(format:json) OK → ${exportedJsonBody.elements.length} elems (type=${exportedJsonBody.type}, v${exportedJsonBody.version})`,
    )

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
