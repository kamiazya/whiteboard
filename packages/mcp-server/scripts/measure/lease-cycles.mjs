/**
 * Whether giving a lease back lets the next one reuse its memory: one record of
 * N documents (360 by default) opened and released six times in one process,
 * with the growth over the starting point after each open and each release.
 * WASM memory never shrinks, so a release can only promise reuse, and the
 * question is whether the process settles or climbs with every cycle.
 *
 * Run (from packages/mcp-server):
 *   DOCUMENTS=360 node --expose-gc --import tsx/esm scripts/measure/lease-cycles.mjs
 */
import { corpusSnapshot } from './corpus-record.mjs'

const adapter = await import('@kamiazya/whiteboard-loro-adapter')
const MB = 1048576
const settled = async () => {
  globalThis.gc()
  globalThis.gc()
  await new Promise((r) => setImmediate(r))
  globalThis.gc()
  const m = process.memoryUsage()
  return { ext: m.external / MB, rss: m.rss / MB, heap: m.heapUsed / MB }
}
const { bytes } = await corpusSnapshot(Number(process.env.DOCUMENTS ?? 360))
const kind = adapter.leaseKind(adapter.loadCrdtEngine)
const base = await settled()
const out = []
for (let i = 0; i < 6; i++) {
  const lease = await kind.load(bytes, [])
  const open = await settled()
  lease.release()
  const rel = await settled()
  out.push(
    `cycle ${i}: open rss +${(open.rss - base.rss).toFixed(1)} ext +${(open.ext - base.ext).toFixed(1)} heap +${(open.heap - base.heap).toFixed(1)} | released rss +${(rel.rss - base.rss).toFixed(1)} ext +${(rel.ext - base.ext).toFixed(1)} heap +${(rel.heap - base.heap).toFixed(1)}`,
  )
}
console.log(out.join('\n'))
process.exit(0)
