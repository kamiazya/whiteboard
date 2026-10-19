/**
 * What a `visual.neon` board costs the PNG export: the real headless
 * exporter (layout, theme, SVG backend, resvg) over a grid of N text nodes
 * chained by N-1 edges, spread across the board so the scene is large while
 * each element is small. Every node and edge glows under neon, and resvg
 * blurs a layer the size of each glowing element's filter region, so this
 * is the number that moves when that region does.
 *
 * Run:
 *   [DEADLINE_MS=300000] node --import tsx/esm scripts/measure/glow-export-cost.mjs [N ...]
 *
 * Each row runs in its own process, killed at `DEADLINE_MS`, so a row that
 * stalls reports `>` the deadline instead of hanging the table.
 */
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_COUNTS = [10, 50, 200]
const PITCH = 220

async function row(count) {
  const { renderSpatialCanvasToPng } = await import('../../src/server/export/headless-renderer.ts')
  const columns = Math.ceil(Math.sqrt(count))
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    type: 'text',
    x: (i % columns) * PITCH,
    y: Math.floor(i / columns) * PITCH,
    width: 120,
    height: 60,
    text: `n${i}`,
  }))
  const edges = nodes.slice(1).map((node, i) => ({
    id: `e${i}`,
    from: { node: nodes[i].id },
    to: { node: node.id },
  }))
  const canvas = { nodes, edges, facets: { 'visual.theme/v0': { theme: 'visual.neon' } } }
  const fonts = join(tmpdir(), 'whiteboard-test-no-installed-fonts')
  // Warm the exporter (font loading) on a one-node board first.
  await renderSpatialCanvasToPng({ nodes: [nodes[0]], edges: [] }, fonts)
  const started = performance.now()
  const result = await renderSpatialCanvasToPng(canvas, fonts, { style: 'document' })
  const ms = Math.round(performance.now() - started)
  process.stdout.write(`${JSON.stringify({ count, ms, bytes: result.png?.length })}\n`)
}

if (process.argv[2] === '--row') {
  await row(Number(process.argv[3]))
} else {
  const counts = process.argv.slice(2).map(Number)
  const deadline = Number(process.env.DEADLINE_MS ?? 300_000)
  const self = fileURLToPath(import.meta.url)
  for (const count of counts.length > 0 ? counts : DEFAULT_COUNTS) {
    const run = spawnSync(process.execPath, ['--import', 'tsx/esm', self, '--row', String(count)], {
      encoding: 'utf8',
      timeout: deadline,
    })
    if (run.error?.code === 'ETIMEDOUT' || run.signal === 'SIGTERM') {
      process.stdout.write(`${JSON.stringify({ count, ms: `>${deadline}` })}\n`)
    } else if (run.status !== 0) {
      process.stdout.write(
        `${JSON.stringify({ count, error: run.stderr.trim().split('\n').pop() })}\n`,
      )
    } else {
      process.stdout.write(run.stdout)
    }
  }
}
