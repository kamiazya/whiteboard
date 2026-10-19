/**
 * What the edge side-choice search and its coincident-ends repair cost one
 * layout on boards a member can plant inside the per-canvas ceilings
 * (`CANVAS_MAX_NODES`, `CANVAS_MAX_EDGES_AND_LINES`). Layout runs on the
 * daemon's request loop for `wb_scene_render`, a laid-out snapshot and every
 * export, so a row here is how long one such call holds that loop.
 *
 * `BOARD` picks the shape:
 * - `parallel` (default): N edges between the same two side-by-side boxes,
 *   no side named — every edge lands in one (node, side) group at each end,
 *   so each trial re-anchors, re-routes and re-scores all N.
 * - `hub`: N edges into one side of a hub box from N sources in a column,
 *   plus `BYSTANDERS` (default 1800) unconnected boxes far away, so every
 *   routing call and every self-penalty walks them too.
 * - `flush`: N edges between two boxes of equal width stacked flush, no side
 *   named — every edge's two ends meet on the shared border, so every one
 *   goes through the coincident-ends repair.
 *
 * Run:
 *   [BOARD=parallel] [ROUTING=orthogonal|straight] [BYSTANDERS=1800] \
 *     [DEADLINE_MS=300000] node --import tsx/esm scripts/measure/edge-side-search-cost.mjs [N ...]
 *
 * Each row runs in its own process, killed at `DEADLINE_MS`, so a row that
 * stalls reports `>` the deadline instead of hanging the table. `ms` is the
 * layout alone (`layoutSpatialCanvas`), the light theme and the
 * constant-ratio measurer — text is not what this prices.
 *
 * Readings before the search and repair were bounded, orthogonal routing, on
 * a shared machine (so compare rows within one sitting, not against these):
 *
 *   parallel  50: 414ms    200: 2417ms   2000: 29133ms
 *   hub       50: 202ms    200: 18543ms  (BYSTANDERS=0: 13079ms)
 *   flush     50: 283ms    200: 1251ms   500: 17130ms  1000: 144140ms
 *             2000: > 300000ms
 *
 * Straight routing prices the same parallel board at 15ms and 60ms: the
 * cost is the orthogonal router and the scoring it feeds, run per trial.
 *
 * Before and after the trial and repair accounts (`routing-budget.ts`), the
 * lane rank by binary search and the patched repair, interleaved twice on a
 * quiet machine:
 *
 *                     before            after
 *   parallel  200     1927 / 2059ms     1492 / 1210ms
 *   parallel  2000    19535 / 19990ms   6957 / 5939ms
 *   hub       200     13284 / 14934ms   2725 / 2527ms
 *   flush     400     5831 / 5430ms     467 / 496ms
 *   flush     2000    > 120000ms        519 / 505ms
 *
 * What is left on the parallel board is the pair loop: every trial re-scores
 * each of the 200 touched edges against the 199 others, and the trial account
 * stops the search after 126 of its 182 trials rather than at a handful.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_COUNTS = [50, 200, 2000]

function board(shape, count, routing, bystanders) {
  const box = (id, x, y, width = 120, height = 60) => ({
    id,
    type: 'text',
    x,
    y,
    width,
    height,
    text: '',
  })
  const nodes = []
  const edges = []
  if (shape === 'hub') {
    nodes.push(box('hub', 2000, 0, 200, 2000))
    for (let i = 0; i < count; i++) {
      nodes.push(box(`s${i}`, 0, i * 80))
      edges.push({ id: `e${i}`, from: { node: `s${i}` }, to: { node: 'hub' } })
    }
    const columns = Math.ceil(Math.sqrt(bystanders))
    for (let i = 0; i < bystanders; i++) {
      nodes.push(box(`b${i}`, 10_000 + (i % columns) * 200, Math.floor(i / columns) * 200))
    }
  } else if (shape === 'flush') {
    nodes.push(box('A', 0, 0, 200, 100), box('B', 0, 100, 200, 100))
    for (let i = 0; i < count; i++)
      edges.push({ id: `e${i}`, from: { node: 'A' }, to: { node: 'B' } })
  } else {
    nodes.push(box('A', 0, 0), box('B', 600, 0))
    for (let i = 0; i < count; i++)
      edges.push({ id: `e${i}`, from: { node: 'A' }, to: { node: 'B' } })
  }
  return { nodes, edges, facets: { 'visual.edges/v0': { routing } } }
}

async function row(count) {
  const { constantRatioMeasureText, createSpatialTheme, layoutSpatialCanvas } = await import(
    '@kamiazya/whiteboard-canvas-render'
  )
  const shape = process.env.BOARD ?? 'parallel'
  const routing = process.env.ROUTING ?? 'orthogonal'
  const bystanders = Number(process.env.BYSTANDERS ?? 1800)
  const options = {
    measure: constantRatioMeasureText,
    appearance: createSpatialTheme({ mode: 'light' }),
  }
  // Warm-up on a small board so module load is not in the row.
  layoutSpatialCanvas(board(shape, 2, routing, 0), options)
  const canvas = board(shape, count, routing, bystanders)
  const start = performance.now()
  const scene = layoutSpatialCanvas(canvas, options)
  const ms = performance.now() - start
  const drawn = scene.nodes.filter((n) => n.kind === 'edge').length
  process.stdout.write(`${JSON.stringify({ ms: Math.round(ms), drawn })}\n`)
}

if (process.env.EDGE_SIDE_SEARCH_ROW !== undefined) {
  await row(Number(process.env.EDGE_SIDE_SEARCH_ROW))
} else {
  const counts = process.argv.slice(2).map(Number)
  const deadline = Number(process.env.DEADLINE_MS ?? 300_000)
  const self = fileURLToPath(import.meta.url)
  console.log(
    `board=${process.env.BOARD ?? 'parallel'} routing=${process.env.ROUTING ?? 'orthogonal'}`,
  )
  console.log('edges\tms\tdrawn')
  for (const count of counts.length > 0 ? counts : DEFAULT_COUNTS) {
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', self], {
      env: { ...process.env, EDGE_SIDE_SEARCH_ROW: String(count) },
      encoding: 'utf8',
      timeout: deadline,
    })
    if (child.error !== undefined) {
      console.log(`${count}\t>${deadline}\t-`)
      continue
    }
    if (child.status !== 0) throw new Error(child.stderr)
    const { ms, drawn } = JSON.parse(child.stdout.trim().split('\n').at(-1))
    console.log(`${count}\t${ms}\t${drawn}`)
  }
}
