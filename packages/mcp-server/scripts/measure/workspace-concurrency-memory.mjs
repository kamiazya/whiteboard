/**
 * What the daemon's memory is when several workspaces are open at once, by
 * record kind: N workspaces of D documents held together, for N = 1, 2, 4, and
 * what stays after they are all given back the way the idle release gives them
 * back (every handle released, nothing re-opened). A last point opens `CHURN`
 * workspaces one after another through the kind's own residency bound (the
 * cache drops the least recently used one over it), which is what a daemon that
 * touches more workspaces than it keeps sees; `BOUNDS` carries those bounds.
 *
 * The record is built once by the parent and handed to each child on stdin; every
 * point of every kind is its own child process, because WASM linear memory never
 * shrinks and one process's high-water mark would be the next point's baseline
 * (`lease-memory.mjs` carries that measurement). Points are run interleaved
 * (kind alternating within each round) for `ROUNDS` rounds and reported as
 * medians, with min and max, of growth over a baseline read after a settled
 * collection before the first open. Reported per point: rss, heapUsed, external,
 * arrayBuffers — a lease's memory lives in the engine's WASM linear memory, so it
 * shows in rss and not in the heap.
 *
 * Run (from packages/mcp-server):
 *   node --expose-gc --import tsx/esm scripts/measure/workspace-concurrency-memory.mjs
 * `DOCUMENTS` (360), `ROUNDS` (5) and `CHURN` (8) size the fixture.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { loadavg } from 'node:os'
import { fileURLToPath } from 'node:url'
import { corpusSnapshot } from './corpus-record.mjs'

const require = createRequire(import.meta.url)
const MB = 1024 * 1024
const DOCUMENTS = Number(process.env.DOCUMENTS ?? 360)
const ROUNDS = Number(process.env.ROUNDS ?? 5)
const CHURN = Number(process.env.CHURN ?? 8)
const HELD = [1, 2, 4]
// The residency bounds the daemon applied per kind while both kinds existed (the lease one is `workspace-record-kind.ts`'s).
const BOUNDS = { loro: 16, lease: 4 }

if (typeof globalThis.gc !== 'function') {
  console.error('FAIL: run with --expose-gc; without it every reading is whatever GC last did')
  process.exit(1)
}

const read = () => {
  globalThis.gc()
  globalThis.gc()
  const m = process.memoryUsage()
  return { rss: m.rss, heap: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers }
}
const growth = (now, base) =>
  Object.fromEntries(Object.keys(now).map((k) => [k, (now[k] - base[k]) / MB]))

async function point(kindName, label) {
  const bytes = new Uint8Array(readFileSync(0))
  const { LoroDoc } = require('loro-crdt')
  const adapter = await import('@kamiazya/whiteboard-loro-adapter')
  const lease = adapter.leaseKind(adapter.loadCrdtEngine)
  const open = () => (kindName === 'loro' ? LoroDoc.fromSnapshot(bytes) : lease.load(bytes, []))
  const give = (record) => (kindName === 'loro' ? record.free() : lease.release(record))
  const baseline = read()
  let held = []
  let held_at_once
  if (label === 'churn') {
    const bound = BOUNDS[kindName]
    for (let i = 0; i < CHURN; i += 1) {
      held.push(await open())
      if (held.length > bound) give(held.shift())
    }
    held_at_once = growth(read(), baseline)
  } else {
    for (let i = 0; i < Number(label); i += 1) held.push(await open())
    held_at_once = growth(read(), baseline)
  }
  for (const record of held) give(record)
  held = []
  await new Promise((resolve) => setImmediate(resolve))
  const after_release = growth(read(), baseline)
  process.stdout.write(`${JSON.stringify({ held: held_at_once, released: after_release })}\n`)
}

function child(kindName, label, bytes) {
  const out = execFileSync(
    process.execPath,
    ['--expose-gc', '--import', 'tsx/esm', fileURLToPath(import.meta.url), kindName, label],
    { cwd: process.cwd(), encoding: 'utf8', input: bytes, stdio: ['pipe', 'pipe', 'inherit'] },
  )
  return JSON.parse(out.trim().split('\n').at(-1))
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

if (process.argv[2] === undefined) {
  const { bytes } = await corpusSnapshot(DOCUMENTS)
  const labels = [...HELD.map(String), 'churn']
  const runs = new Map()
  const load0 = loadavg()[0]
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const label of labels) {
      for (const kindName of round % 2 === 0 ? ['loro', 'lease'] : ['lease', 'loro']) {
        const key = `${kindName}/${label}`
        runs.set(key, [...(runs.get(key) ?? []), child(kindName, label, bytes)])
      }
    }
  }
  console.log(
    `  ${DOCUMENTS} documents per workspace (${(bytes.byteLength / MB).toFixed(1)}MB snapshot), ${ROUNDS} interleaved rounds, medians (min-max) of growth in MB, load ${load0.toFixed(1)} -> ${loadavg()[0].toFixed(1)}`,
  )
  console.log(
    '  kind   workspaces        state     rss (min-max)       heap  external  arrayBuffers',
  )
  for (const label of labels) {
    for (const kindName of ['loro', 'lease']) {
      const rs = runs.get(`${kindName}/${label}`)
      for (const state of ['held', 'released']) {
        const col = (f) => rs.map((r) => r[state][f])
        const rss = col('rss')
        const name = label === 'churn' ? `${CHURN} via bound ${BOUNDS[kindName]}` : `${label} held`
        console.log(
          `  ${kindName.padEnd(5)}  ${name.padEnd(16)}  ${state.padEnd(8)}  ${median(rss).toFixed(1).padStart(7)} (${Math.min(...rss).toFixed(0)}-${Math.max(...rss).toFixed(0)})  ${median(col('heap')).toFixed(1).padStart(7)}  ${median(col('external')).toFixed(1).padStart(8)}  ${median(col('arrayBuffers')).toFixed(1).padStart(8)}`,
        )
      }
    }
  }
  process.exit(0)
} else {
  await point(process.argv[2], process.argv[3])
  process.exit(0)
}
