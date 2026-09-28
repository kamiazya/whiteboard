// The in-page half of `measure-workspace-record-memory.mjs`, served by its
// vite server and driven over playwright. It is a module rather than code
// passed to `page.evaluate` so vite resolves `loro-crdt` and the adapter
// exactly as the app's own build does: the `bundler/` entry through
// vite-plugin-wasm (see the driver's config).
//
// The WASM memory is read from the instance itself. The driver's init script
// wraps `WebAssembly.instantiate*` before any module runs and keeps every
// instance's `exports.memory` in `window.__wasmMemories`; `preflight` then
// establishes WHICH of them Loro allocates in, rather than assuming the first.
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'

const MB = 1024 * 1024
const memories = () => /** @type {WebAssembly.Memory[]} */ (globalThis.__wasmMemories ?? [])
const sizes = () => memories().map((m) => m.buffer.byteLength)

/**
 * The memory Loro allocates in, by capture order — which `preflight` proves
 * on a page of its own. It runs on its own page because its 32MB ballast,
 * freed, would stay in the memory as reusable space and hide that much of
 * the next record's growth.
 */
let loroMemory = null
const bytes = () => loroMemory.buffer.byteLength

/**
 * Allocates 32MB of text INSIDE Loro and reports how every captured memory
 * moved. The one that grew by at least that is Loro's; if none did, nothing
 * this page reports afterwards would be a reading.
 */
async function preflight() {
  const before = sizes()
  const doc = new LoroDoc()
  const text = doc.getText('ballast')
  const chunk = 'abcdefghijklmnopqrstuvwxyz012345'.repeat(32 * 1024) // 1MB
  for (let i = 0; i < 32; i += 1) text.insert(text.length, chunk)
  doc.commit()
  // Read back before measuring: an allocation nothing touches is one a
  // runtime may elide.
  const witness = text.length
  const after = sizes()
  doc.free()
  const grewMb = after.map((a, i) => (a - (before[i] ?? 0)) / MB)
  const index = grewMb.findIndex((g) => g >= 30)
  if (index >= 0) loroMemory = memories()[index]

  // The other candidate reading. It needs cross-origin isolation, and only
  // Chromium ships it; it is reported for comparison, never used for rows.
  let uaSpecific = 'unavailable'
  if (
    globalThis.crossOriginIsolated &&
    typeof performance.measureUserAgentSpecificMemory === 'function'
  ) {
    const ua = async () => (await performance.measureUserAgentSpecificMemory()).bytes / MB
    const a = await ua()
    const probe = new LoroDoc()
    const t = probe.getText('ballast')
    for (let i = 0; i < 32; i += 1) t.insert(t.length, chunk)
    probe.commit()
    const b = await ua()
    uaSpecific = `+${(b - a).toFixed(1)}MB for a second 32MB Loro text (${probe.getText('ballast').length} chars)`
    probe.free()
  }
  return { memories: memories().length, grewMb, witness, found: index, uaSpecific }
}

/**
 * One count on this page's one allocation history: build the record through
 * the browser keeper's write path, then export it while it is live.
 */
function measure(corpus, count, memoryIndex) {
  loroMemory = memories()[memoryIndex]
  const base = bytes()
  const stage = { name: 'build', built: 0 }
  try {
    const record = new LoroDoc()
    record.setPeerId(1n)
    for (let i = 0; i < count; i += 1) {
      const doc = corpus[i % corpus.length]
      const documentId = `01ARZ3NDEKTSV4RRFF${String(i).padStart(8, '0')}`
      createWorkspaceDocumentAtPath(record, {
        path: `copy${Math.floor(i / corpus.length)}/${doc.path}`,
        documentId,
        kind: 'markdown',
      })
      writeMarkdownBody(documentContainers(record, documentId), doc.body)
      stage.built = i + 1
    }
    record.commit()
    const live = bytes()
    stage.name = 'export'
    const snapshot = record.export({ mode: 'snapshot' }).byteLength
    const peak = bytes()
    return { ok: true, base, live, peak, snapshot }
  } catch (err) {
    return {
      ok: false,
      stage: stage.name,
      built: stage.built,
      base,
      reached: bytes(),
      error: String(err?.message ?? err).slice(0, 200),
    }
  }
}

globalThis.__recordMemory = { preflight, measure }
