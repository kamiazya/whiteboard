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
//   2. viewport_set rejects immediately with no_client when no browser is connected
//   3. export_canvas(format:png) falls back to headless rendering when no browser is connected
//   4. export_canvas(format:json) round-trips a known element shape
//   5. export_canvas(format:png) honours theme=light / theme=dark
//   6. export_canvas(format:svg) renders real SVG markup headless
//
// For 2 and 3 there is no browser WS client, so success behavior is not
// observed. Instead, the smoke proves that both route wiring and MCP wrapping
// are correct because the no_client error is returned immediately.
//
// This does not consume API quota, so it is safe in CI. For real LLM-driven
// execution, use scripts/smoke/mcp-claude-cli-smoke.mjs.

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// fetch() treats Host as a forbidden header and silently drops any override,
// so a genuine Host-header spoof for the DNS-rebinding guard test needs a raw
// node:http request instead.
function requestWithHostHeader(url, hostHeader) {
  return new Promise((resolveReq, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'GET',
        headers: { Host: hostHeader },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolveReq({ status: res.statusCode }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const tmpDataDir = mkdtempSync(join(tmpdir(), 'whiteboard-e2e-'))
const entryArg = process.argv.find((arg) => arg.startsWith('--entry='))
const entry = resolve(
  root,
  entryArg ? entryArg.slice('--entry='.length) : 'src/server/mcp/index.ts',
)
const childArgs = entry.endsWith('.ts') ? ['--import', 'tsx/esm', entry] : [entry]

const child = spawn('node', childArgs, {
  cwd: root,
  env: { ...process.env, WHITEBOARD_DATA_DIR: tmpDataDir },
  stdio: ['pipe', 'pipe', 'pipe'],
})

// `WHITEBOARD_E2E_STDERR_FILE=<path>` mirrors the child's stderr to a file
// so tracing checks can inspect OTel span output without failing the smoke
// just to print stderr.
const stderrMirrorPath = process.env.WHITEBOARD_E2E_STDERR_FILE
const stderrMirror = stderrMirrorPath
  ? (await import('node:fs')).createWriteStream(stderrMirrorPath, { flags: 'w' })
  : null
let stderrBuf = ''
child.stderr.on('data', (c) => {
  if (stderrMirror) stderrMirror.write(c)
  stderrBuf += c.toString()
})

// Response parser for newline-delimited JSON. Buffers are accumulated and
// split as Buffers (not strings) before the final utf-8 decode: a large
// message (e.g. the ~8MB canvas-viewer widget HTML in a resources/read
// response) arrives split across multiple 'data' events, and decoding each
// chunk to a string independently corrupts any multi-byte UTF-8 character
// that straddles a chunk boundary (each half decodes to a replacement
// character on its own). Decoding only once a full line's bytes are known
// to be present avoids that class of corruption.
const pending = new Map()
let stdoutBuf = Buffer.alloc(0)
child.stdout.on('data', (chunk) => {
  stdoutBuf = Buffer.concat([stdoutBuf, chunk])
  let idx
  while ((idx = stdoutBuf.indexOf(0x0a)) !== -1) {
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

// The first tools/call spawns the daemon, so its latency includes the full
// daemon cold-start. CI runners exceed the 20s default; the env override lets
// release jobs wait longer without slowing local runs.
const RPC_TIMEOUT_MS = /^\d+$/.test(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS ?? '')
  ? Number(process.env.WHITEBOARD_SMOKE_RPC_TIMEOUT_MS)
  : 20_000

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
    }, RPC_TIMEOUT_MS)
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
  const initResult = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-smoke', version: '0.0.0' },
  })
  notify('notifications/initialized', {})

  // MCP Apps (SEP-1865) extension declaration: io.modelcontextprotocol/ui
  // must appear in the initialize result's server capabilities.extensions.
  const UI_EXTENSION_ID = 'io.modelcontextprotocol/ui'
  if (!initResult?.capabilities?.extensions?.[UI_EXTENSION_ID]) {
    throw new Error(
      `initialize result missing extensions.${UI_EXTENSION_ID}: ${JSON.stringify(initResult?.capabilities)}`,
    )
  }
  console.log(`[e2e] initialize → capabilities.extensions.${UI_EXTENSION_ID} present OK`)

  const tools = await rpc('tools/list', {})
  const names = tools.tools.map((t) => t.name)
  if (!names.includes('version_save') || !names.includes('version_restore')) {
    throw new Error(`version tools missing from tools/list: ${names.join(', ')}`)
  }

  // MCP Apps UI linkage: exactly canvas_view carries `_meta.ui.resourceUri`;
  // canvas_open/export_canvas must NOT (see tool-registration.ts).
  const UI_RESOURCE_URI = 'ui://whiteboard/canvas-view'
  const uiLinkedNames = tools.tools
    .filter((t) => t._meta?.ui?.resourceUri === UI_RESOURCE_URI)
    .map((t) => t.name)
  if (uiLinkedNames.length !== 1 || uiLinkedNames[0] !== 'canvas_view') {
    throw new Error(`expected exactly canvas_view UI-linked, got: ${JSON.stringify(uiLinkedNames)}`)
  }
  console.log('[e2e] tools/list → canvas_view is the sole UI-linked tool OK')

  const resourceList = await rpc('resources/list', {})
  const uiResourceEntry = resourceList.resources.find((r) => r.uri === UI_RESOURCE_URI)
  if (!uiResourceEntry || uiResourceEntry.mimeType !== 'text/html;profile=mcp-app') {
    throw new Error(`ui:// resource missing/wrong mimeType: ${JSON.stringify(uiResourceEntry)}`)
  }

  const resourceRead = await rpc('resources/read', { uri: UI_RESOURCE_URI })
  const widgetHtmlPath = resolve(
    root,
    '..',
    'canvas-viewer',
    'dist',
    'widget',
    'canvas-viewer.html',
  )
  const expectedWidgetHtml = readFileSync(widgetHtmlPath, 'utf-8')
  const actualWidgetHtml = resourceRead.contents?.[0]?.text
  if (actualWidgetHtml !== expectedWidgetHtml) {
    throw new Error(
      'resources/read ui://whiteboard/canvas-view did not match the shipped widget bundle byte-for-byte',
    )
  }
  console.log(
    '[e2e] resources/read ui://whiteboard/canvas-view → byte-identical to shipped widget OK',
  )

  const created = await callTool('canvas_create', { slug: 'e2e-src' })
  if (!created.id || !created.url) throw new Error('canvas_create returned unexpected shape')
  console.log(`[e2e] canvas_create → ${created.id}`)

  // The daemon is up now (canvas_create spawned it) — exercise the local-daemon
  // auth hardening directly over HTTP: instanceId-shaped ping, and the
  // Host-guard rejecting a spoofed non-loopback Host on /api/*.
  const daemonOrigin = new URL(created.url).origin
  const pingRes = await fetch(`${daemonOrigin}/api/runtime/ping`)
  const pingBody = await pingRes.json()
  if (pingRes.status !== 200 || pingBody.ok !== true || typeof pingBody.instanceId !== 'string') {
    throw new Error(`ping did not return an instanceId-shaped body: ${JSON.stringify(pingBody)}`)
  }
  if ('pid' in pingBody) {
    throw new Error(`ping response still leaks pid: ${JSON.stringify(pingBody)}`)
  }
  console.log(`[e2e] /api/runtime/ping → instanceId=${pingBody.instanceId}, no pid`)

  const spoofedRes = await requestWithHostHeader(`${daemonOrigin}/api/runtime/ping`, 'evil.example')
  if (spoofedRes.status !== 403) {
    throw new Error(`spoofed Host GET expected 403, got ${spoofedRes.status}`)
  }
  console.log('[e2e] /api/runtime/ping with spoofed Host → 403 OK')

  // POST /api/ws-ticket (ADR-0005). No WHITEBOARD_OAUTH_CLIENT_REGISTRY is
  // configured for this smoke's daemon, so no OAuth grant exists to redeem a
  // bearer against — this proves the route is actually mounted and reachable
  // through the real HTTP stack (unlike a unit test against the router in
  // isolation) and that it fails closed with no live grant, rather than 404
  // (unmounted) or a 200 with a ticket minted from nothing.
  const wsTicketRes = await fetch(`${daemonOrigin}/api/ws-ticket`, { method: 'POST' })
  if (wsTicketRes.status !== 401) {
    throw new Error(`POST /api/ws-ticket with no bearer expected 401, got ${wsTicketRes.status}`)
  }
  console.log('[e2e] POST /api/ws-ticket with no bearer → 401 OK')

  // Token channel split (ADR-0002 addendum): the served HTML must never carry
  // the daemon token inside __WHITEBOARD_RUNTIME_CONFIG__. This is a
  // serialization-surface reduction, not a security boundary — a script that
  // ran earlier in the page could still have observed the token global before
  // TokenStore consumed it.
  const canvasHtmlRes = await fetch(created.url)
  const canvasHtml = await canvasHtmlRes.text()
  if (canvasHtml.includes('daemonToken')) {
    throw new Error('served HTML still carries daemonToken inside __WHITEBOARD_RUNTIME_CONFIG__')
  }
  if (canvasHtml.includes('__WHITEBOARD_RUNTIME_CONFIG__')) {
    // The injection path ran (dist/web-app exists). ensureDaemon always
    // generates a token (nanoid), so the dedicated token global must
    // accompany the config script.
    if (!canvasHtml.includes('window.__WHITEBOARD_DAEMON_TOKEN__')) {
      throw new Error('served HTML is missing window.__WHITEBOARD_DAEMON_TOKEN__')
    }
    console.log('[e2e] served HTML: no daemonToken in config, dedicated token global present')
  } else {
    // No injected config at all — dist/web-app is absent (CI runs this
    // smoke before pnpm build), so there is no injection path to verify here.
    console.log(
      '[e2e] served HTML has no runtime-config injection (dist/web-app absent) — token-global check skipped',
    )
  }

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

  // Exercise annotate_batch with an arrow that uses text as a label alias.
  // The SDK validates structuredContent against outputSchema at runtime, so
  // any drift between the Zod schema and the actual payload surfaces here.
  const batchArrow = await callTool('annotate_batch', {
    canvasId: created.id,
    annotations: [
      {
        type: 'arrow',
        target: { x: 0, y: 0 },
        endTarget: { x: 100, y: 0 },
        coords: 'absolute',
        text: 'smoke-label',
      },
    ],
  })
  if (!batchArrow.annotations?.[0]?.labelId) {
    throw new Error(
      `annotate_batch arrow with text alias did not produce labelId: ${JSON.stringify(batchArrow)}`,
    )
  }
  console.log(
    `[e2e] annotate_batch → arrow with text-as-label alias (labelId=${batchArrow.annotations[0].labelId})`,
  )

  // update_element must reject `text` patches targeting an arrow's own
  // element (arrows label via a separate bound text element, not a `text`
  // field on the arrow) instead of returning ok:true for a no-op.
  await expectRejected(
    callTool('update_element', {
      canvasId: created.id,
      elementId: batchArrow.annotations[0].arrowId,
      patch: { text: 'should not silently no-op' },
    }),
    /label/i,
    'update_element text patch on an arrow element',
  )
  console.log('[e2e] update_element → rejects text patch on arrow OK')

  // update_element on the arrow's own separately-tracked label element must
  // still work — this is the actual supported way to edit an existing label.
  const updatedLabel = await callTool('update_element', {
    canvasId: created.id,
    elementId: batchArrow.annotations[0].labelId,
    patch: { text: 'smoke-label-updated' },
  })
  if (updatedLabel.elementId !== batchArrow.annotations[0].labelId) {
    throw new Error(
      `update_element on label returned unexpected shape: ${JSON.stringify(updatedLabel)}`,
    )
  }
  console.log('[e2e] update_element → updates arrow label element text OK')

  // Exercise create_frame so any drift between its zod outputSchema
  // (assignedMembers etc.) and the runtime payload trips the SDK's structured-
  // content validator at this layer instead of leaking out to MCP clients.
  const rectId = ann.elementId ?? ann.elementIds?.[0]
  if (!rectId) throw new Error('annotate returned no rectangle id to seed create_frame')
  const frame = await callTool('create_frame', {
    canvasId: created.id,
    name: 'e2e-frame',
    memberIds: [rectId],
  })
  if (!frame.elementId || !Array.isArray(frame.assignedMembers)) {
    throw new Error(`create_frame returned unexpected shape: ${JSON.stringify(frame)}`)
  }
  console.log(`[e2e] create_frame → ${frame.elementId} (${frame.assignedMembers.length} members)`)

  // Exercise align_elements / distribute_elements so any drift between
  // their Zod input schema and the registered tool surface trips the SDK
  // structured-content validator here instead of in production.
  const layoutIds = []
  for (let i = 0; i < 3; i++) {
    const r = await callTool('annotate', {
      canvasId: created.id,
      type: 'rectangle',
      // target's Zod schema is { x, y } — Zod v4 strips unknown keys, so
      // width/height nested inside target would be silently discarded.
      // Hoist them to the top-level annotate parameters.
      target: { x: 200 + i * 50, y: 200 + i * 30 },
      coords: 'absolute',
      width: 60,
      height: 40,
      color: '#1971c2',
    })
    const id = r.elementId ?? r.elementIds?.[0]
    if (!id) throw new Error(`layout annotate ${i} returned no id`)
    layoutIds.push(id)
  }

  // Box-snapped arrow with NO target/endTarget at all — the documented
  // startBoxId/endBoxId path (annotate's field descriptions say they replace
  // target/endTarget). The Zod input schema previously required target
  // unconditionally, so this call would fail with -32602 before the schema
  // fix; catching that regression here is the point of this smoke step.
  const snappedArrow = await callTool('annotate', {
    canvasId: created.id,
    type: 'arrow',
    coords: 'absolute',
    startBoxId: layoutIds[0],
    endBoxId: layoutIds[1],
  })
  if (!snappedArrow.elementId && !snappedArrow.elementIds) {
    throw new Error(
      `annotate (targetless box-snapped arrow) returned unexpected shape: ${JSON.stringify(snappedArrow)}`,
    )
  }
  console.log('[e2e] annotate → targetless box-snapped arrow (startBoxId/endBoxId, no target)')

  const aligned = await callTool('align_elements', {
    canvasId: created.id,
    elementIds: layoutIds,
    alignment: 'left',
  })
  if (aligned.alignment !== 'left' || aligned.elementIds.length !== 3) {
    throw new Error(`align_elements returned unexpected shape: ${JSON.stringify(aligned)}`)
  }
  const distributed = await callTool('distribute_elements', {
    canvasId: created.id,
    elementIds: layoutIds,
    direction: 'horizontal',
  })
  if (distributed.direction !== 'horizontal' || distributed.elementIds.length !== 3) {
    throw new Error(`distribute_elements returned unexpected shape: ${JSON.stringify(distributed)}`)
  }
  console.log('[e2e] align_elements / distribute_elements → OK')

  const insBefore = await callTool('canvas_inspect', { canvasId: created.id })
  if (insBefore.elementCount < 1)
    throw new Error(`source canvas missing element: ${JSON.stringify(insBefore)}`)

  // canvas_inspect must surface the frame's name, otherwise a caller can see a
  // frame exists but not what it is called. Cross-checks the elementSummarySchema
  // `name` field against the real create_frame({ name: 'e2e-frame' }) payload above.
  const inspectedFrame = insBefore.elements.find((e) => e.id === frame.elementId)
  if (!inspectedFrame || inspectedFrame.name !== 'e2e-frame') {
    throw new Error(
      `canvas_inspect missing/incorrect frame name: ${JSON.stringify(inspectedFrame)}`,
    )
  }
  console.log(`[e2e] canvas_inspect → frame name "${inspectedFrame.name}" OK`)

  // canvas_view (MCP Apps UI-linked tool): structuredContent.scene must be a
  // renderable {elements} shape — parsed inline here rather than importing
  // the canvas-viewer package's parseViewerScene from a shell script.
  const viewed = await callTool('canvas_view', { canvasId: created.id })
  if (viewed.canvasId !== created.id || !Array.isArray(viewed.scene?.elements)) {
    throw new Error(`canvas_view returned unexpected shape: ${JSON.stringify(viewed)}`)
  }
  if (viewed.scene.elements.length < 1) {
    throw new Error(`canvas_view returned an empty scene: ${JSON.stringify(viewed)}`)
  }
  console.log(`[e2e] canvas_view → scene with ${viewed.scene.elements.length} element(s) OK`)

  // version_save labels the current state and returns a versionId. The
  // restore-as-new-canvas flow (formerly the checkpoint pair) is now
  // version_restore with targetSlug.
  const saved = await callTool('version_save', { canvasId: created.id, label: 'e2e' })
  if (!saved.versionId) throw new Error('version_save returned no id')
  if (saved.elementCount !== insBefore.elementCount) {
    throw new Error(
      `element count mismatch: save=${saved.elementCount} inspect=${insBefore.elementCount}`,
    )
  }
  console.log(`[e2e] version_save → ${saved.versionId} (${saved.elementCount} elems)`)

  const restored = await callTool('version_restore', {
    canvasId: created.id,
    versionId: saved.versionId,
    targetSlug: 'e2e-restored',
  })
  if (restored.restoredAs !== 'new-canvas') {
    throw new Error(`expected new-canvas restore, got ${restored.restoredAs}`)
  }
  if (!restored.canvasId.endsWith('/e2e-restored')) {
    throw new Error(`unexpected restore canvasId: ${restored.canvasId}`)
  }
  console.log(`[e2e] version_restore → ${restored.canvasId}`)

  const insAfter = await callTool('canvas_inspect', { canvasId: restored.canvasId })
  if (insAfter.elementCount !== insBefore.elementCount) {
    throw new Error(
      `restored elementCount ${insAfter.elementCount} ≠ original ${insBefore.elementCount}`,
    )
  }
  const types = (insAfter.elements ?? []).map((e) => e.type)
  if (!types.includes('rectangle'))
    throw new Error(`restored canvas missing rectangle: ${JSON.stringify(insAfter)}`)
  console.log(
    `[e2e] canvas_inspect(restored) → ${insAfter.elementCount} elems, types=${types.join(',')}`,
  )

  // Confirm overwrite behavior when the restore target already exists.
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

  // version_list should surface the version we just saved.
  const listed = await callTool('version_list', { canvasId: created.id })
  if (!listed.versions.some((v) => v.id === saved.versionId)) {
    throw new Error(`version_list missing the saved id: ${JSON.stringify(listed)}`)
  }
  console.log('[e2e] version_list contains saved versionId')

  // optimize_canvases: per-canvas form must echo the slug we passed and
  // return a single result. Bulk form must include the source canvas at
  // minimum. Reasons may be 'ok' / 'no-gain' / 'no-versions' depending on
  // doc size and whether the canvas has any saved versions — what matters
  // is the wire shape stays stable.
  const sourceSlug = created.id.split('/').slice(1).join('/')
  const optOne = await callTool('optimize_canvases', { slug: sourceSlug })
  if (optOne.results.length !== 1 || optOne.results[0].slug !== sourceSlug) {
    throw new Error(`optimize_canvases per-canvas wrong shape: ${JSON.stringify(optOne)}`)
  }
  console.log(
    `[e2e] optimize_canvases(${sourceSlug}) → reason=${optOne.results[0].reason} before=${optOne.totalBeforeBytes} after=${optOne.totalAfterBytes}`,
  )

  const optAll = await callTool('optimize_canvases', {})
  const optimizedSlugs = optAll.results.map((r) => r.slug)
  if (!optimizedSlugs.includes(sourceSlug)) {
    throw new Error(`optimize_canvases bulk missing source canvas: ${JSON.stringify(optAll)}`)
  }
  console.log(
    `[e2e] optimize_canvases(all) → ${optAll.results.length} canvases, total before=${optAll.totalBeforeBytes} after=${optAll.totalAfterBytes}`,
  )

  // viewport_set: no browser connected -> immediate no_client rejection.
  // This is the key part of the repeatable pattern: even browser-dependent tools
  // can still prove WS route wiring without connecting a browser.
  await expectRejected(
    callTool('viewport_set', { canvasId: created.id, mode: 'fit' }),
    /No browser client/i,
    'viewport_set without browser client',
  )
  console.log('[e2e] viewport_set → no_client OK (route wiring verified)')

  // export_canvas(format:png) against a non-existent canvas must fail loudly.
  // The previous headless path silently returned an empty PNG for any typoed
  // slug because getDoc / loadCanvas resolve to an empty LoroDoc on cache
  // miss; we now 404 up front so the caller sees the typo.
  await expectRejected(
    callTool('export_canvas', {
      canvasId: `${created.id.split('/')[0]}/no-such-canvas`,
      format: 'png',
    }),
    /canvas_not_found|404/i,
    'export_canvas(format:png) against missing canvas',
  )
  console.log('[e2e] export_canvas(format:png) → canvas_not_found OK for missing canvas')

  // export_canvas(format:png): with no browser connected, the route falls
  // back to the headless renderer (jsdom + @napi-rs/canvas + resvg-js).
  // Confirm we get a .excalidraw.png file path back instead of a no_client
  // rejection.
  const exportedPng = await callTool('export_canvas', { canvasId: created.id, format: 'png' })
  if (
    exportedPng.format !== 'png' ||
    !exportedPng.filePath ||
    !exportedPng.filePath.endsWith('.excalidraw.png')
  ) {
    throw new Error(
      `export_canvas(format:png) returned unexpected shape: ${JSON.stringify(exportedPng)}`,
    )
  }
  console.log(`[e2e] export_canvas(format:png) (headless) → ${exportedPng.filePath}`)

  // The .excalidraw.png contract requires the scene JSON to be embedded as a
  // tEXt chunk so dropping the file back onto the canvas restores the scene.
  // Walk the PNG chunks looking for Excalidraw's metadata keyword. This is
  // the last line of defense against a regression in headless-export's
  // embed step — the unit tests cover the embed helper, but only the real
  // resvg PNG goes through this path.
  {
    const { readFile: _readEmbed } = await import('node:fs/promises')
    const png = await _readEmbed(exportedPng.filePath)
    let pos = 8
    let foundKeyword = null
    while (pos + 12 <= png.length) {
      const len = png.readUInt32BE(pos)
      const type = png.subarray(pos + 4, pos + 8).toString('latin1')
      if (type === 'tEXt') {
        const data = png.subarray(pos + 8, pos + 8 + len)
        const sep = data.indexOf(0)
        foundKeyword = data.subarray(0, sep).toString('latin1')
        break
      }
      pos += 12 + len
    }
    if (foundKeyword !== 'application/vnd.excalidraw+json') {
      throw new Error(
        `export_canvas(format:png) (headless) PNG is missing the embedded Excalidraw scene chunk (got keyword=${foundKeyword}).`,
      )
    }
    console.log('[e2e] export_canvas(format:png) (headless) embeds Excalidraw scene tEXt chunk')
  }

  // load_image + export_canvas(format:png): confirm that BinaryFiles flow
  // end-to-end so that a regression in loadCanvasFiles (e.g. wrong path
  // layout) shows up here. We use a tiny solid-color PNG so the assertion is
  // robust against the exact pixel size of the embedded image.
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGUlEQVR4nGP8z8DAwIQDMOEUobiUgQEkAQATDQMR/HpTEgAAAABJRU5ErkJggg==',
    'base64',
  )
  const tinyPngPath = join(tmpDataDir, 'tiny.png')
  writeFileSync(tinyPngPath, tinyPng)
  const loaded = await callTool('load_image', { canvasId: created.id, imagePath: tinyPngPath })
  if (!loaded.elementId) {
    throw new Error(`load_image returned unexpected shape: ${JSON.stringify(loaded)}`)
  }
  const exportedWithImage = await callTool('export_canvas', {
    canvasId: created.id,
    format: 'png',
  })
  if (!exportedWithImage.filePath || !exportedWithImage.filePath.endsWith('.excalidraw.png')) {
    throw new Error(
      `export_canvas(format:png) after load_image returned unexpected shape: ${JSON.stringify(exportedWithImage)}`,
    )
  }
  console.log(
    `[e2e] load_image + export_canvas(format:png) (headless) → ${exportedWithImage.filePath}`,
  )

  // export_canvas(format:png) theme=light/dark: export the same canvas twice
  // with explicit themes to defend the headless renderer's theme handling.
  // If the renderer ignores `theme`, both files would be byte-identical and
  // the contrast QA workflow recommended in
  // skills/drawing-visuals/dark-mode-techniques.md would silently produce
  // identical exports.
  const themeExportsDir = join(tmpDataDir, created.id.split('/')[0], 'exports')
  const lightOut = join(themeExportsDir, 'theme-light.png')
  const darkOut = join(themeExportsDir, 'theme-dark.png')
  const themeLight = await callTool('export_canvas', {
    canvasId: created.id,
    format: 'png',
    theme: 'light',
    outputPath: lightOut,
    overwrite: true,
  })
  const themeDark = await callTool('export_canvas', {
    canvasId: created.id,
    format: 'png',
    theme: 'dark',
    outputPath: darkOut,
    overwrite: true,
  })
  if (themeLight.filePath !== lightOut || themeDark.filePath !== darkOut) {
    throw new Error(
      `theme exports landed at unexpected paths: ${JSON.stringify({ themeLight, themeDark })}`,
    )
  }
  const { readFile: readPng, stat: statPng } = await import('node:fs/promises')
  const [lightBytes, darkBytes, lightStat, darkStat] = await Promise.all([
    readPng(lightOut),
    readPng(darkOut),
    statPng(lightOut),
    statPng(darkOut),
  ])
  if (lightStat.size === 0 || darkStat.size === 0) {
    throw new Error('theme export produced an empty PNG')
  }
  if (lightBytes.equals(darkBytes)) {
    throw new Error(
      'export_canvas(format:png) produced byte-identical PNGs for theme=light and theme=dark — the renderer is ignoring theme.',
    )
  }
  console.log(
    `[e2e] export_canvas(format:png) theme=light/dark differ (${lightStat.size}B vs ${darkStat.size}B) — theme honored`,
  )

  // export_canvas(format:svg): always rendered headless from the persisted
  // document, so no browser client is required.
  const canvasSvg = await callTool('export_canvas', { canvasId: created.id, format: 'svg' })
  if (canvasSvg.format !== 'svg' || !canvasSvg.filePath.endsWith('.svg')) {
    throw new Error(
      `export_canvas(format:svg) returned unexpected shape: ${JSON.stringify(canvasSvg)}`,
    )
  }
  const { readFile } = await import('node:fs/promises')
  const svgMarkup = await readFile(canvasSvg.filePath, 'utf-8')
  if (!svgMarkup.trim().startsWith('<svg')) {
    throw new Error('export_canvas(format:svg) did not produce real SVG markup')
  }
  console.log('[e2e] export_canvas(format:svg) OK (real <svg> markup on disk)')

  // export_canvas(format:json): pure LoroDoc readback with no browser
  // required, exported to standard .excalidraw format. Read the JSON back and
  // verify wrapper shape and element count directly.
  const canvasJson = await callTool('export_canvas', { canvasId: created.id, format: 'json' })
  if (canvasJson.format !== 'json' || !canvasJson.filePath.endsWith('.excalidraw')) {
    throw new Error(
      `export_canvas(format:json) returned unexpected shape: ${JSON.stringify(canvasJson)}`,
    )
  }
  const body = JSON.parse(await readFile(canvasJson.filePath, 'utf-8'))
  if (body.type !== 'excalidraw' || body.version !== 2) {
    throw new Error(
      `exported JSON has wrong wrapper: ${JSON.stringify({ type: body.type, version: body.version })}`,
    )
  }
  if (!Array.isArray(body.elements) || body.elements.length !== canvasJson.elementCount) {
    throw new Error(
      `element count mismatch: body.elements=${body.elements?.length} elementCount=${canvasJson.elementCount}`,
    )
  }
  const rectInExport = body.elements.find((el) => el.type === 'rectangle')
  if (!rectInExport) throw new Error('exported JSON missing rectangle we annotated earlier')
  console.log(
    `[e2e] export_canvas(format:json) OK → ${body.elements.length} elems (type=${body.type}, v${body.version})`,
  )

  // library_list_items via a local .excalidrawlib file: validates that the
  // schema-based normalizeLibraryPayload accepts a standard v2 payload and that
  // the MCP SDK validates the structured response against libraryListItemsOutputSchema.
  const libPath = join(tmpDataDir, 'smoke.excalidrawlib')
  writeFileSync(
    libPath,
    JSON.stringify({
      type: 'excalidrawlib',
      version: 2,
      libraryItems: [
        {
          id: 'smoke-item',
          name: 'smoke rect',
          elements: [{ id: 'el-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 }],
        },
      ],
    }),
  )
  const libListed = await callTool('library_list_items', { libraryPath: libPath })
  if (libListed.itemCount !== 1 || libListed.items[0]?.name !== 'smoke rect') {
    throw new Error(`library_list_items returned unexpected shape: ${JSON.stringify(libListed)}`)
  }
  console.log(
    `[e2e] library_list_items → itemCount=${libListed.itemCount} name=${libListed.items[0].name}`,
  )

  // create_pairing_link: the MCP SDK validates structuredContent against the
  // tool's outputSchema at runtime, so this exercises drift the type system
  // can't see. Decode the emitted fragment and structurally check it against
  // the daemon-connection-payload contract (baseUrl matches the live daemon,
  // authMode/bootstrapToken coherent).
  const workspaceId = created.id.split('/')[0]
  const pairing = await callTool('create_pairing_link', {
    workspaceId,
    slug: sourceSlug,
  })
  if (!pairing.url || !pairing.webOrigin || !pairing.authMode) {
    throw new Error(`create_pairing_link returned unexpected shape: ${JSON.stringify(pairing)}`)
  }
  const expectedPrefix = `${pairing.webOrigin}/#wb=`
  if (!pairing.url.startsWith(expectedPrefix)) {
    throw new Error(
      `create_pairing_link url does not start with "${expectedPrefix}": ${pairing.url}`,
    )
  }
  const fragmentB64 = pairing.url.slice(expectedPrefix.length)
  const decodedPayload = JSON.parse(Buffer.from(fragmentB64, 'base64url').toString('utf-8'))
  if (decodedPayload.baseUrl !== daemonOrigin) {
    throw new Error(
      `create_pairing_link payload baseUrl ${decodedPayload.baseUrl} ≠ live daemon origin ${daemonOrigin}`,
    )
  }
  if (decodedPayload.workspaceId !== workspaceId || decodedPayload.slug !== sourceSlug) {
    throw new Error(
      `create_pairing_link payload workspaceId/slug mismatch: ${JSON.stringify(decodedPayload)}`,
    )
  }
  if (
    decodedPayload.authMode === 'bootstrap' &&
    (typeof decodedPayload.bootstrapToken !== 'string' || decodedPayload.bootstrapToken.length < 8)
  ) {
    throw new Error(
      `create_pairing_link bootstrap payload missing a valid token: ${JSON.stringify(decodedPayload)}`,
    )
  }
  console.log(
    `[e2e] create_pairing_link → ${pairing.authMode} url for baseUrl=${decodedPayload.baseUrl}`,
  )

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
