import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'

interface RunOptions {
  /** Absolute path to the MCP server entry point (.ts for dev, .js for packaged). */
  entry: string
  /** Package root used as cwd for the spawned child process. */
  root: string
}

type RpcResponse = {
  content?: Array<{ type: string; text: string }>
  isError?: boolean
}

export async function runE2eCheckpointSmoke({ entry, root }: RunOptions): Promise<void> {
  const tmpDataDir = mkdtempSync(join(tmpdir(), 'whiteboard-e2e-'))
  const childArgs = entry.endsWith('.ts') ? ['--import', 'tsx/esm', entry] : [entry]

  const child = spawn('node', childArgs, {
    cwd: root,
    env: { ...process.env, WHITEBOARD_DATA_DIR: tmpDataDir },
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
      }, 20_000)
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
      throw new Error(
        `${label}: wrong error: ${err instanceof Error ? err.message : String(err)}`,
      )
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

    const created = await callTool('canvas_create', { slug: 'e2e-src' })
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
    console.log(`[e2e] canvas_list → ${(listed.workspaces as unknown[]).length} workspaces, ${totalCanvases} canvases`)

    const palette = await callTool('palette_get', { workspaceId })
    if (typeof palette.palette !== 'object' || palette.palette === null) {
      throw new Error(`palette_get returned unexpected shape: ${JSON.stringify(palette)}`)
    }
    console.log('[e2e] palette_get → OK')

    const libsInstalled = await callTool('library_list_installed', {})
    if (!Array.isArray(libsInstalled.installedUrls)) {
      throw new Error(`library_list_installed returned unexpected shape: ${JSON.stringify(libsInstalled)}`)
    }
    console.log(`[e2e] library_list_installed → ${(libsInstalled.installedUrls as unknown[]).length} urls`)

    // library_uninstall with a never-installed URL. removeInstalledLibrary is an idempotent SQL DELETE
    // that returns the current installed list, so this succeeds offline without any HTTPS fetch.
    const libUninstalled = await callTool('library_uninstall', {
      libraryUrl: 'https://smoke-test.example.com/never-installed.excalidrawlib',
    })
    if (!Array.isArray(libUninstalled.installedUrls)) {
      throw new Error(`library_uninstall returned unexpected shape: ${JSON.stringify(libUninstalled)}`)
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

    await expectRejected(
      callTool('export_png', { canvasId: created.id }),
      /No browser client/i,
      'export_png without browser client',
    )
    console.log('[e2e] export_png → no_client OK (route wiring verified)')

    const exported = await callTool('canvas_export_json', { canvasId: created.id })
    if (!exported.filePath || !(exported.filePath as string).endsWith('.excalidraw')) {
      throw new Error(`canvas_export_json returned unexpected shape: ${JSON.stringify(exported)}`)
    }
    const body = JSON.parse(await readFile(exported.filePath as string, 'utf-8')) as {
      type: string
      version: number
      elements: Array<{ type: string }>
    }
    if (body.type !== 'excalidraw' || body.version !== 2) {
      throw new Error(
        `exported JSON has wrong wrapper: ${JSON.stringify({ type: body.type, version: body.version })}`,
      )
    }
    if (!Array.isArray(body.elements) || body.elements.length !== exported.elementCount) {
      throw new Error(
        `element count mismatch: body.elements=${body.elements?.length} elementCount=${exported.elementCount}`,
      )
    }
    const rectInExport = body.elements.find((el) => el.type === 'rectangle')
    if (!rectInExport) throw new Error('exported JSON missing rectangle we annotated earlier')
    console.log(
      `[e2e] canvas_export_json → ${body.elements.length} elems in standard JSON (type=${body.type}, v${body.version})`,
    )

    console.log('\n[e2e] ALL OK')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
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
