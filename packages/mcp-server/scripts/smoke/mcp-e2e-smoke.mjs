#!/usr/bin/env node
// End-to-end smoke test that runs through an MCP stdio subprocess.
//
// Purpose:
// Start the MCP server outside the parent client's context and verify that each
// OpenCanvas tool behaves according to spec using JSON-RPC stdio.
//
// Coverage:
//   1. tools/list matches the authoritative set in mcp-smoke-coverage.ts
//   2. wb_canvas_create → facet_set → version_save → version_list → version_restore
//
// This does not consume API quota, so it is safe in CI.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const tmpDataDir = mkdtempSync(`${tmpdir()}/whiteboard-e2e-`)
const entryArg = process.argv.find((arg) => arg.startsWith('--entry='))
const entry = resolve(
  root,
  entryArg ? entryArg.slice('--entry='.length) : 'src/server/mcp/index.ts',
)
const childArgs = entry.endsWith('.ts') ? ['--import', 'tsx/esm', entry] : [entry]

const child = spawn('node', childArgs, {
  cwd: root,
  env: { ...process.env, WHITEBOARD_DATA_DIR: tmpDataDir, WHITEBOARD_NO_WATCH: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stderrBuf = ''
child.stderr.on('data', (c) => {
  stderrBuf += c.toString()
})

const pending = new Map()
let stdoutBuf = Buffer.alloc(0)
child.stdout.on('data', (chunk) => {
  stdoutBuf = Buffer.concat([stdoutBuf, chunk])
  for (let idx = stdoutBuf.indexOf(0x0a); idx !== -1; idx = stdoutBuf.indexOf(0x0a)) {
    const line = stdoutBuf.subarray(0, idx).toString('utf-8')
    stdoutBuf = stdoutBuf.subarray(idx + 1)
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

const RPC_TIMEOUT_MS = /^\d+$/.test(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS ?? '')
  ? Number(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS)
  : 20_000

let nextId = 1
function rpc(method, params) {
  const id = nextId++
  return new Promise((resolveRpc, reject) => {
    pending.set(id, { resolve: resolveRpc, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`RPC ${method} (#${id}) timed out`))
      }
    }, RPC_TIMEOUT_MS)
  })
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args })
  if (!res || !Array.isArray(res.content) || res.content[0]?.type !== 'text') {
    throw new Error(`unexpected tool/call result shape: ${JSON.stringify(res)}`)
  }
  const text = res.content[0].text
  if (res.isError) throw new Error(text)
  return JSON.parse(text)
}

function cleanup(exitCode) {
  try {
    child.kill('SIGTERM')
  } catch {}
  rmSync(tmpDataDir, { recursive: true, force: true })
  if (exitCode !== 0 && stderrBuf) {
    console.error(`\n--- MCP stderr ---\n${stderrBuf}\n--- end ---`)
  }
  process.exit(exitCode)
}

process.on('SIGINT', () => cleanup(130))

/** Workspace slug used for every canvas the smoke creates. */
const WORKSPACE_ID = 'e2e'

// Authoritative tool list — must match ALL_REGISTERED_TOOLS in mcp-smoke-coverage.ts.
const EXPECTED_TOOLS = [
  'body_patch',
  'canvas_digest',
  'canvas_export_json_canvas',
  'canvas_export_okf',
  'canvas_import_okf',
  'canvas_render_svg',
  'edge_patch',
  'facet_set',
  'node_patch',
  'version_list',
  'version_restore',
  'version_save',
  'wb_canvas_create',
  'wb_canvas_delete',
  'wb_canvas_get',
  'wb_canvas_list',
]

async function main() {
  console.log(`[e2e] entry → ${entry}`)

  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-smoke', version: '0.0.0' },
  })
  notify('notifications/initialized', {})

  // tools/list: verify the exact set matches the authoritative list.
  const tools = await rpc('tools/list', {})
  const names = tools.tools.map((t) => t.name).sort()
  const expected = [...EXPECTED_TOOLS].sort()
  const inLiveNotExpected = names.filter((n) => !expected.includes(n))
  const inExpectedNotLive = expected.filter((n) => !names.includes(n))
  if (inLiveNotExpected.length > 0 || inExpectedNotLive.length > 0) {
    const lines = ['tools/list does not match expected tool set.']
    if (inLiveNotExpected.length > 0) {
      lines.push(`  In tools/list but not expected: ${inLiveNotExpected.join(', ')}`)
    }
    if (inExpectedNotLive.length > 0) {
      lines.push(`  Expected but not in tools/list: ${inExpectedNotLive.join(', ')}`)
    }
    throw new Error(lines.join('\n'))
  }
  console.log(`[e2e] tools/list → ${names.length} tools match expected set`)

  // wb_canvas_create: first daemon-dependent RPC (cold-start latency).
  const created = await callTool('wb_canvas_create', {
    workspaceId: WORKSPACE_ID,
    segment: 'e2e-src',
  })
  if (typeof created.canvasId !== 'string' || created.segment !== 'e2e-src') {
    throw new Error(`wb_canvas_create returned unexpected shape: ${JSON.stringify(created)}`)
  }
  const canvasId = created.canvasId
  console.log(`[e2e] wb_canvas_create → ${canvasId}`)

  // facet_set: seed extension-facet state so version_save has content.
  const facets = await callTool('facet_set', {
    workspaceId: WORKSPACE_ID,
    canvasId,
    facets: { 'e2e/1': { note: 'before-save' } },
  })
  if (facets.canvasId !== canvasId) {
    throw new Error(`facet_set returned unexpected shape: ${JSON.stringify(facets)}`)
  }
  console.log('[e2e] facet_set → seeded canvas state')

  // version_save
  const saved = await callTool('version_save', {
    canvasId,
    label: 'e2e',
  })
  if (
    !saved.versionId ||
    saved.canvasId !== canvasId ||
    saved.label !== 'e2e' ||
    !saved.timestamp ||
    !saved.frontier
  ) {
    throw new Error(`version_save returned unexpected shape: ${JSON.stringify(saved)}`)
  }
  console.log(`[e2e] version_save → ${saved.versionId}`)

  // version_list
  const listed = await callTool('version_list', { canvasId })
  if (
    listed.canvasId !== canvasId ||
    !Array.isArray(listed.versions) ||
    !listed.versions.some((v) => v.versionId === saved.versionId)
  ) {
    throw new Error(`version_list missing the saved id: ${JSON.stringify(listed)}`)
  }
  console.log(`[e2e] version_list → ${listed.versions.length} version(s)`)

  // version_restore
  const restored = await callTool('version_restore', {
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
    throw new Error(`version_restore returned unexpected shape: ${JSON.stringify(restored)}`)
  }
  console.log(`[e2e] version_restore → ${restored.restoredVersionId}`)

  // canvas_import_okf → canvas_export_okf round-trip
  const importMarkdown =
    '---\ntype: issue\nfacets:\n  issue/1:\n    status: open\n---\nImported body.'
  const imported = await callTool('canvas_import_okf', {
    workspaceId: WORKSPACE_ID,
    canvasId,
    markdown: importMarkdown,
  })
  if (!imported.imported || imported.canvasId !== canvasId) {
    throw new Error(`canvas_import_okf returned unexpected shape: ${JSON.stringify(imported)}`)
  }
  console.log('[e2e] canvas_import_okf → imported')

  const exported = await callTool('canvas_export_okf', {
    workspaceId: WORKSPACE_ID,
    canvasId,
  })
  if (!exported.markdown.includes('Imported body.')) {
    throw new Error(`canvas_export_okf body mismatch after import: ${exported.markdown}`)
  }
  if (!exported.frontmatter.facets?.['issue/1']) {
    throw new Error(
      `canvas_export_okf facets missing after import: ${JSON.stringify(exported.frontmatter)}`,
    )
  }
  console.log('[e2e] canvas_export_okf → round-trip verified')

  console.log('\n[e2e] ALL OK')
}

main().then(
  () => cleanup(0),
  (err) => {
    console.error(`[e2e] FAIL: ${err.message}`)
    cleanup(1)
  },
)
