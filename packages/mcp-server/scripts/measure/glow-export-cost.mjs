/**
 * What a `visual.neon` board costs the PNG export: the real headless
 * exporter (layout, theme, SVG backend, resvg) over a grid of N text nodes
 * chained by N-1 edges, spread across the board so the scene is large while
 * each element is small. Every node and edge glows under neon, and resvg
 * blurs a layer the size of each glowing element's filter region, so this
 * is the number that moves when that region does.
 *
 * `BOARD` picks the board's shape:
 * - `grid` (default): the board above — the ordinary case.
 * - `corners`: the same grid plus N edges from the top-left node to the
 *   bottom-right one, each a scene-sized glow region.
 * - `huge`: the grid plus N nodes as large as the whole board.
 * - `bubbles`: the grid plus N open comment threads on one node, each with a
 *   long body, so their drop-shadowed bubbles stack.
 *
 * Each row also reports `filterMpx`: the summed area of every filter region
 * the SVG references, clipped to the canvas, at the export's scale — the
 * quantity the backend's filter budget bounds.
 *
 * Run:
 *   [BOARD=grid] [SCALE=1] [DEADLINE_MS=300000] \
 *     node --import tsx/esm scripts/measure/glow-export-cost.mjs [N ...]
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

/** Summed filter-region area in megapixels, read off the SVG itself. */
function filterMpx(svg, scale) {
  const [vx, vy, vw, vh] = /viewBox="([^"]+)"/.exec(svg)[1].split(' ').map(Number)
  const glow = new Map()
  for (const m of svg.matchAll(
    /<filter id="([^"]+)" filterUnits="userSpaceOnUse" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g,
  )) {
    glow.set(m[1], m.slice(2, 6).map(Number))
  }
  let area = 0
  for (const m of svg.matchAll(/<(\w+) ([^>]*?)filter="url\(#([^)]+)\)"/g)) {
    let box = glow.get(m[3])
    if (box === undefined) {
      const attr = (name) => Number(new RegExp(` ${name}="([^"]+)"`).exec(` ${m[2]}`)?.[1])
      const [x, y, w, h] = [attr('x'), attr('y'), attr('width'), attr('height')]
      box = [x - 0.3 * w, y - 0.3 * h, 1.6 * w, 1.6 * h]
    }
    const w = Math.max(0, Math.min(box[0] + box[2], vx + vw) - Math.max(box[0], vx))
    const h = Math.max(0, Math.min(box[1] + box[3], vy + vh) - Math.max(box[1], vy))
    area += w * h
  }
  return Math.round((area * scale * scale) / 1e4) / 100
}

async function row(count) {
  const { renderSpatialCanvasToPng, renderSpatialCanvasToSvg } = await import(
    '../../src/server/export/headless-renderer.ts'
  )
  const shape = process.env.BOARD ?? 'grid'
  const scale = Number(process.env.SCALE ?? 1)
  const base = shape === 'grid' ? count : 200
  const columns = Math.ceil(Math.sqrt(base))
  const nodes = Array.from({ length: base }, (_, i) => ({
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
  const last = nodes[nodes.length - 1]
  const side = columns * PITCH
  const extra = Array.from({ length: shape === 'grid' ? 0 : count }, (_, i) => i)
  const corners =
    shape === 'corners'
      ? extra.map((i) => ({ id: `c${i}`, from: { node: nodes[0].id }, to: { node: last.id } }))
      : []
  const huge =
    shape === 'huge'
      ? extra.map((i) => ({
          id: `h${i}`,
          type: 'text',
          x: 0,
          y: 0,
          width: side,
          height: side,
          text: '',
        }))
      : []
  const comments =
    shape === 'bubbles'
      ? extra.map((i) => ({
          id: `t${i}`,
          x: nodes[0].x + 120,
          y: nodes[0].y,
          text: `${i} ${'lorem ipsum dolor sit amet '.repeat(150)}`.slice(0, 4096),
          targetNodeId: nodes[0].id,
        }))
      : []
  const canvas = {
    nodes: [...nodes, ...huge],
    edges: [...edges, ...corners],
    ...(comments.length > 0 ? { comments } : {}),
    facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
  }
  const fonts = join(tmpdir(), 'whiteboard-test-no-installed-fonts')
  // Warm the exporter (font loading) on a one-node board first.
  await renderSpatialCanvasToPng({ nodes: [nodes[0]], edges: [] }, fonts)
  const started = performance.now()
  const result = await renderSpatialCanvasToPng(canvas, fonts, { style: 'document', scale })
  const ms = Math.round(performance.now() - started)
  const { svg } = await renderSpatialCanvasToSvg(canvas, fonts, { style: 'document' })
  const mpx = filterMpx(svg, scale)
  process.stdout.write(
    `${JSON.stringify({ shape, count, scale, ms, filterMpx: mpx, bytes: result.png?.length })}\n`,
  )
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
      const timedOut = { count, ms: `>${deadline}` }
      process.stdout.write(`${JSON.stringify(timedOut)}\n`)
    } else if (run.status !== 0) {
      process.stdout.write(
        `${JSON.stringify({ count, error: run.stderr.trim().split('\n').pop() })}\n`,
      )
    } else {
      process.stdout.write(run.stdout)
    }
  }
}
