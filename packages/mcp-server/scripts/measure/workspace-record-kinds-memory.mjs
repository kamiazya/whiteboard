/**
 * What the daemon holds when several workspaces are open at once, by record
 * kind: 4 workspaces of 360 documents each, held together, then given back the
 * way the idle release gives them back, then opened again.
 *
 * The record is built once by the parent and read from a file; each row is its
 * own child process, because WASM linear memory never shrinks and one
 * process's high-water mark would be the next row's baseline
 * (`lease-memory.mjs` carries that measurement). `rss` is the growth over a
 * baseline read after a settled collection before the first open. A release
 * that frees memory the process reuses shows as a small "reopened" figure,
 * which is all a release can promise here: the engine keeps its pages.
 *
 * Run (from packages/mcp-server):
 *   node --expose-gc --import tsx/esm scripts/measure/workspace-record-kinds-memory.mjs
 * `WORKSPACES` and `DOCUMENTS` size the fixture (4 and 360 by default).
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
const WORKSPACES = Number(process.env.WORKSPACES ?? 4)
const DOCUMENTS = Number(process.env.DOCUMENTS ?? 360)

if (typeof globalThis.gc !== 'function') {
  console.error('FAIL: run with --expose-gc; without it every reading is whatever GC last did')
  process.exit(1)
}

const settled = () => {
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().rss / MB
}

async function openAll(kindName, file) {
  const bytes = new Uint8Array(readFileSync(file))
  const { LoroDoc } = require('loro-crdt')
  const adapter = await import('@kamiazya/whiteboard-loro-adapter')
  const lease = adapter.leaseKind(adapter.loadCrdtEngine)
  const open = () => (kindName === 'loro' ? LoroDoc.fromSnapshot(bytes) : lease.load(bytes, []))
  const give = (record) => (kindName === 'loro' ? record.free() : lease.release(record))

  const baseline = settled()
  let held = []
  for (let i = 0; i < WORKSPACES; i += 1) held.push(await open())
  const opened = settled() - baseline
  for (const record of held) give(record)
  held = []
  await new Promise((resolve) => setImmediate(resolve))
  const released = settled() - baseline
  for (let i = 0; i < WORKSPACES; i += 1) held.push(await open())
  const reopened = settled() - released - baseline
  void held
  process.stdout.write(`${JSON.stringify({ kindName, opened, released, reopened })}\n`)
}

function child(kindName, file) {
  const out = execFileSync(
    process.execPath,
    ['--expose-gc', '--import', 'tsx/esm', fileURLToPath(import.meta.url), kindName, file],
    { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
  return JSON.parse(out.trim().split('\n').at(-1))
}

if (process.argv[2] === undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-record-kinds-'))
  const { bytes } = await corpusSnapshot(DOCUMENTS)
  const file = join(dir, 'record.bin')
  writeFileSync(file, bytes)
  console.log(
    `  ${WORKSPACES} workspaces x ${DOCUMENTS} documents, ${(bytes.byteLength / MB).toFixed(1)}MB each as a snapshot`,
  )
  console.log('  kind    held at once   after release   reopened (growth over after-release)')
  for (const kindName of ['loro', 'lease']) {
    const row = child(kindName, file)
    console.log(
      `  ${kindName.padEnd(5)}   ${row.opened.toFixed(1).padStart(9)}MB   ${row.released.toFixed(1).padStart(10)}MB   ${row.reopened.toFixed(1).padStart(10)}MB`,
    )
  }
  process.exit(0)
} else {
  await openAll(process.argv[2], process.argv[3])
  process.exit(0)
}
