/**
 * What a workspace record costs in memory when it is held as an engine lease
 * rather than as a `LoroDoc`, at 90, 360 and 720 documents of real prose.
 *
 * The snapshot is built once by the parent and written to a file; each row is
 * its own child process that only OPENS those bytes, one way each, because
 * WASM linear memory never shrinks and a record built in the same process would
 * leave its high-water mark for the next to reuse (`workspace-record-memory.mjs`
 * carries the measurement behind that). Figures are `external` and `rss` after a
 * settled collection, as the growth over a baseline read before the open, and
 * again after one whole-record export, which is what a read of the record costs
 * beside it, and a third time after the record is given back (a lease released,
 * a document freed) and the event loop has turned. Differences under 1 MB are WASM page grants, not readings.
 *
 * Run (from packages/mcp-server):
 *   node --expose-gc --import tsx/esm scripts/measure/lease-memory.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { corpusSnapshot } from './corpus-record.mjs'

const require = createRequire(import.meta.url)
const MB = 1024 * 1024
const COUNTS = (process.env.COUNTS ?? '90,360,720').split(',').map(Number)

if (typeof globalThis.gc !== 'function') {
  console.error('FAIL: run with --expose-gc; without it every reading is whatever GC last did')
  process.exit(1)
}

const settled = () => {
  globalThis.gc()
  globalThis.gc()
  const { external, rss, heapUsed } = process.memoryUsage()
  return { external: external / MB, rss: rss / MB, heap: heapUsed / MB }
}
const grew = (after, before) => ({
  external: after.external - before.external,
  rss: after.rss - before.rss,
  heap: after.heap - before.heap,
})

/** One way of holding the bytes, in this process, printed as one JSON row. */
async function openOne(way, file) {
  const bytes = new Uint8Array(readFileSync(file))
  const { LoroDoc } = require('loro-crdt')
  const adapter = await import('@kamiazya/whiteboard-loro-adapter')
  const before = settled()
  let exportBytes
  const kind = adapter.leaseKind(adapter.loadCrdtEngine)
  let held
  if (way === 'loro') {
    held = LoroDoc.fromSnapshot(bytes)
  } else {
    held = await kind.load(bytes, [])
  }
  const opened = grew(settled(), before)
  if (way === 'loro') exportBytes = held.export({ mode: 'snapshot' }).byteLength
  else exportBytes = kind.exportSnapshot(held).byteLength
  const exported = grew(settled(), before)
  // Given back, and a turn of the event loop for the finalizers a handle leaves behind.
  if (way === 'loro') held.free()
  else held.release()
  held = undefined
  await new Promise((resolve) => setImmediate(resolve))
  const afterRelease = settled()
  const released = grew(afterRelease, before)
  // The same bytes opened again over what the release left behind: growth near
  // nothing means the memory a release frees is reused, which is all a release
  // can promise a process whose wasm memory never shrinks.
  held = way === 'loro' ? LoroDoc.fromSnapshot(bytes) : await kind.load(bytes, [])
  const reopened = grew(settled(), afterRelease)
  process.stdout.write(
    `${JSON.stringify({ way, opened, exported, released, reopened, exportBytes })}\n`,
  )
  void held
}

function child(way, file) {
  const out = execFileSync(
    process.execPath,
    ['--expose-gc', '--import', 'tsx/esm', fileURLToPath(import.meta.url), way, file],
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
  return JSON.parse(out.trim().split('\n').at(-1))
}

if (process.argv[2] === undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-lease-memory-'))
  console.log(
    '  docs   snapshot   way     open ext   open rss   +export ext   +export rss   released ext   released rss   reopen ext   reopen rss',
  )
  for (const count of COUNTS) {
    const { bytes } = await corpusSnapshot(count)
    const file = join(dir, `${count}.bin`)
    writeFileSync(file, bytes)
    for (const way of ['loro', 'lease']) {
      const row = child(way, file)
      console.log(
        `  ${String(count).padStart(4)}   ${(bytes.byteLength / MB).toFixed(1).padStart(6)}MB   ` +
          `${way.padEnd(5)}   ${row.opened.external.toFixed(1).padStart(6)}MB   ` +
          `${row.opened.rss.toFixed(1).padStart(6)}MB   ` +
          `${row.exported.external.toFixed(1).padStart(8)}MB   ${row.exported.rss.toFixed(1).padStart(8)}MB   ` +
          `${row.released.external.toFixed(1).padStart(10)}MB   ${row.released.rss.toFixed(1).padStart(10)}MB   ` +
          `${row.reopened.external.toFixed(1).padStart(8)}MB   ${row.reopened.rss.toFixed(1).padStart(8)}MB`,
      )
    }
  }
  process.exit(0)
} else {
  await openOne(process.argv[2], process.argv[3])
  process.exit(0)
}
