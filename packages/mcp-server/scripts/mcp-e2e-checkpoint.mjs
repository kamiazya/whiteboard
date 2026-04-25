#!/usr/bin/env node
// End-to-end smoke test that runs through an MCP stdio subprocess.
//
// Purpose:
// Start the MCP server outside the parent client's context and verify that each
// tool behaves according to spec even with no prior conversation context, using
// JSON-RPC stdio. This is the standard repeatable verification pattern when you
// want deterministic behavior without reconnecting the main client.
//
// Coverage:
//   1. canvas_create -> annotate -> canvas_inspect
//   2. checkpoint_save -> checkpoint_restore -> canvas_inspect element recovery
//   3. checkpoint_restore branches for overwrite=true and validation errors
//   4. viewport_set rejects immediately with no_client when no browser is connected
//   5. export_png rejects immediately with no_client when no browser is connected
//
// For 4 and 5 there is no browser WS client, so success behavior is not
// observed. Instead, the smoke proves that both route wiring and MCP wrapping
// are correct because the no_client error is returned immediately.
//
// This does not consume API quota, so it is safe in CI. For real LLM-driven
// execution, use scripts/mcp-claude-cli-smoke.mjs.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const tmpDataDir = mkdtempSync(join(tmpdir(), 'whiteboard-e2e-'))
const entryArg = process.argv.find((arg) => arg.startsWith('--entry='))
const entry = resolve(root, entryArg ? entryArg.slice('--entry='.length) : 'src/server/mcp/index.ts')
const childArgs = entry.endsWith('.ts') ? ['--import', 'tsx/esm', entry] : [entry]

const child = spawn('node', childArgs, {
  cwd: root,
  env: { ...process.env, WHITEBOARD_DATA_DIR: tmpDataDir },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stderrBuf = ''
child.stderr.on('data', (c) => {
  stderrBuf += c.toString()
})

// Response parser for newline-delimited JSON.
const pending = new Map()
let stdoutBuf = ''
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString()
  let idx
  while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, idx)
    stdoutBuf = stdoutBuf.slice(idx + 1)
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve: r, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`RPC ${msg.id}: ${JSON.stringify(msg.error)}`))
      else r(msg.result)
    }
  }
})

let nextId = 1
function rpc(method, params) {
  const id = nextId++
  const req = { jsonrpc: '2.0', id, method, params }
  return new Promise((resolveRpc, reject) => {
    pending.set(id, { resolve: resolveRpc, reject })
    child.stdin.write(JSON.stringify(req) + '\n')
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`RPC ${method} (#${id}) timed out`))
      }
    }, 20_000)
  })
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args })
  if (!res || !Array.isArray(res.content) || res.content[0]?.type !== 'text') {
    throw new Error(`unexpected tool/call result shape: ${JSON.stringify(res)}`)
  }
  const text = res.content[0].text
  if (res.isError) {
    // If the tool throws internally, text contains a plain error message.
    throw new Error(text)
  }
  return JSON.parse(text)
}

function cleanup(exitCode) {
  try {
    child.kill('SIGTERM')
  } catch {}
  rmSync(tmpDataDir, { recursive: true, force: true })
  if (exitCode !== 0 && stderrBuf) {
    console.error('\n--- MCP stderr ---\n' + stderrBuf + '\n--- end ---')
  }
  process.exit(exitCode)
}

process.on('SIGINT', () => cleanup(130))

async function main() {
  console.log(`[e2e] entry → ${entry}`)

  // Wait briefly for the Hono server to finish starting.
  // If initialize succeeds, the MCP server is up.
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-smoke', version: '0.0.0' },
  })
  notify('notifications/initialized', {})

  const tools = await rpc('tools/list', {})
  const names = tools.tools.map((t) => t.name)
  if (!names.includes('checkpoint_save') || !names.includes('checkpoint_restore')) {
    throw new Error(`checkpoint tools missing from tools/list: ${names.join(', ')}`)
  }

  const created = await callTool('canvas_create', { slug: 'e2e-src' })
  if (!created.id || !created.url) throw new Error('canvas_create returned unexpected shape')
  console.log(`[e2e] canvas_create → ${created.id}`)

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

  const insBefore = await callTool('canvas_inspect', { canvasId: created.id })
  if (insBefore.elementCount < 1) throw new Error(`source canvas missing element: ${JSON.stringify(insBefore)}`)

  const saved = await callTool('checkpoint_save', { canvasId: created.id })
  if (!saved.checkpointId) throw new Error('checkpoint_save returned no id')
  if (saved.elementCount !== insBefore.elementCount) {
    throw new Error(`element count mismatch: save=${saved.elementCount} inspect=${insBefore.elementCount}`)
  }
  console.log(`[e2e] checkpoint_save → ${saved.checkpointId} (${saved.elementCount} elems)`)

  const restored = await callTool('checkpoint_restore', {
    checkpointId: saved.checkpointId,
    targetSlug: 'e2e-restored',
  })
  if (!restored.canvasId.endsWith('/e2e-restored')) {
    throw new Error(`unexpected restore canvasId: ${restored.canvasId}`)
  }
  console.log(`[e2e] checkpoint_restore → ${restored.canvasId}`)

  const insAfter = await callTool('canvas_inspect', { canvasId: restored.canvasId })
  if (insAfter.elementCount !== insBefore.elementCount) {
    throw new Error(
      `restored elementCount ${insAfter.elementCount} ≠ original ${insBefore.elementCount}`,
    )
  }
  const types = (insAfter.elements ?? []).map((e) => e.type)
  if (!types.includes('rectangle')) throw new Error(`restored canvas missing rectangle: ${JSON.stringify(insAfter)}`)
  console.log(`[e2e] canvas_inspect(restored) → ${insAfter.elementCount} elems, types=${types.join(',')}`)

  // Confirm overwrite behavior when the restore target already exists.
  await expectRejected(
    callTool('checkpoint_restore', {
      checkpointId: saved.checkpointId,
      targetSlug: 'e2e-restored',
    }),
    /already exists/,
    'duplicate restore without overwrite',
  )

  await callTool('checkpoint_restore', {
    checkpointId: saved.checkpointId,
    targetSlug: 'e2e-restored',
    overwrite: true,
  })
  console.log(`[e2e] checkpoint_restore overwrite=true OK`)

  // Invalid ids should be rejected.
  await expectRejected(
    callTool('checkpoint_save', { canvasId: created.id, id: '../escape' }),
    /Invalid checkpoint id/,
    'bad checkpoint id',
  )
  console.log('[e2e] validation errors propagate correctly')

  // viewport_set: no browser connected -> immediate no_client rejection.
  // This is the key part of the repeatable pattern: even browser-dependent tools
  // can still prove WS route wiring without connecting a browser.
  await expectRejected(
    callTool('viewport_set', { canvasId: created.id, mode: 'fit' }),
    /No browser client/i,
    'viewport_set without browser client',
  )
  console.log('[e2e] viewport_set → no_client OK (route wiring verified)')

  // export_png: same expectation as above.
  await expectRejected(
    callTool('export_png', { canvasId: created.id }),
    /No browser client/i,
    'export_png without browser client',
  )
  console.log('[e2e] export_png → no_client OK (route wiring verified)')

  // canvas_export_json: pure LoroDoc readback with no browser required, then
  // export to standard .excalidraw format.
  // Read the JSON back and verify wrapper shape and element count directly.
  const { readFile } = await import('node:fs/promises')
  const exported = await callTool('canvas_export_json', { canvasId: created.id })
  if (!exported.filePath || !exported.filePath.endsWith('.excalidraw')) {
    throw new Error(`canvas_export_json returned unexpected shape: ${JSON.stringify(exported)}`)
  }
  const body = JSON.parse(await readFile(exported.filePath, 'utf-8'))
  if (body.type !== 'excalidraw' || body.version !== 2) {
    throw new Error(`exported JSON has wrong wrapper: ${JSON.stringify({ type: body.type, version: body.version })}`)
  }
  if (!Array.isArray(body.elements) || body.elements.length !== exported.elementCount) {
    throw new Error(`element count mismatch: body.elements=${body.elements?.length} elementCount=${exported.elementCount}`)
  }
  const rectInExport = body.elements.find((el) => el.type === 'rectangle')
  if (!rectInExport) throw new Error('exported JSON missing rectangle we annotated earlier')
  console.log(`[e2e] canvas_export_json → ${body.elements.length} elems in standard JSON (type=${body.type}, v${body.version})`)

  console.log('\n[e2e] ALL OK')
}

async function expectRejected(promise, pattern, label) {
  try {
    await promise
  } catch (err) {
    if (pattern.test(err.message)) return
    throw new Error(`${label}: wrong error: ${err.message}`)
  }
  throw new Error(`${label}: expected rejection but resolved`)
}

main().then(
  () => cleanup(0),
  (err) => {
    console.error(`[e2e] FAIL: ${err.message}`)
    cleanup(1)
  },
)
