/**
 * What resvg's synchronous `render()` costs for an inline `data:image/svg+xml`
 * image that carries its own filter work — the shape a text node's body
 * reaches with `![x](data:image/svg+xml;base64,…)`, which the PNG export
 * sizes by the nested root's declared width × height alone.
 *
 * Run:
 *   [DEADLINE_MS=60000] node scripts/measure/nested-svg-filter-cost.mjs \
 *     [kind:side:primitives:radius:zoom ...]
 *
 * `kind` is `morph` (feMorphology dilate), `blur` (feGaussianBlur), `conv`
 * (feConvolveMatrix of order `radius`), `mask`, `pattern`, or `plain` (no
 * filter — the control). `side` is the nested SVG's declared square size in
 * px, `primitives` how many filter primitives (or masks) it chains, and
 * `zoom` the export scale (`fitTo: zoom`, at most 8). Each row runs in its
 * own process, killed at `DEADLINE_MS`, so a row that stalls reports `>`
 * the deadline instead of hanging the table, and a row that fails reports
 * its error rather than passing for a stall.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROWS = [
  'plain:400:1:0:8',
  'morph:100:1:10:1',
  'morph:100:1:40:1',
  'morph:100:1:160:1',
  'morph:200:1:40:1',
  'morph:400:1:40:1',
  'morph:100:10:40:1',
  'morph:100:1:10:2',
  'morph:100:1:10:4',
  'morph:100:1:10:8',
  'blur:400:100:50:8',
  'conv:100:1:30:8',
  'mask:400:100:0:8',
  'pattern:400:100:0:8',
]

const svgFor = (kind, side, n, r) => {
  const rect = (attrs) => `<rect width="${side}" height="${side}" fill="red" ${attrs}/>`
  if (kind === 'plain') return rect('')
  if (kind === 'mask') {
    let body = rect('')
    for (let i = 0; i < n; i++) {
      body = `<mask id="m${i}">${rect('fill="white"')}</mask><g mask="url(#m${i})">${body}</g>`
    }
    return body
  }
  if (kind === 'pattern') {
    let body = ''
    for (let i = 0; i < n; i++) {
      const filled = rect(`fill="url(#p${i})"`)
      body += `<pattern id="p${i}" width="1" height="1" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="blue"/></pattern>${filled}`
    }
    return body
  }
  const primitive = {
    morph: `<feMorphology operator="dilate" radius="${r}"/>`,
    blur: `<feGaussianBlur stdDeviation="${r}"/>`,
    conv: `<feConvolveMatrix order="${r}" kernelMatrix="${new Array(r * r).fill(1).join(' ')}"/>`,
  }[kind]
  return `<filter id="f" x="0" y="0" width="1" height="1">${primitive.repeat(n)}</filter>${rect('filter="url(#f)"')}`
}

if (process.argv[2] === '--row') {
  const [kind, side, n, r, zoom] = process.argv[3].split(':').map((v, i) => (i ? Number(v) : v))
  const require = createRequire(import.meta.url)
  const { Resvg } = require('@resvg/resvg-js')
  const inner = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}">${svgFor(kind, side, n, r)}</svg>`
  const href = `data:image/svg+xml;base64,${Buffer.from(inner).toString('base64')}`
  const outer = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><image width="${side}" height="${side}" href="${href}"/></svg>`
  const start = performance.now()
  new Resvg(outer, { fitTo: { mode: 'zoom', value: zoom } }).render()
  process.stdout.write(String(Math.round(performance.now() - start)))
} else {
  const deadline = Number(process.env.DEADLINE_MS ?? 60_000)
  const rows = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_ROWS
  const self = fileURLToPath(import.meta.url)
  process.stdout.write('kind     side  prims  radius  zoom   render ms\n')
  for (const row of rows) {
    const [kind, side, n, r, zoom] = row.split(':')
    const run = spawnSync(process.execPath, [self, '--row', row], {
      timeout: deadline,
      encoding: 'utf8',
    })
    let ms
    if (run.status === 0) {
      ms = run.stdout
    } else if (run.error?.code === 'ETIMEDOUT') {
      ms = `> ${deadline}`
    } else {
      const exited = `exit ${run.status}`
      const reason = run.error?.message ?? run.stderr.match(/^\w*Error\b.*$/m)?.[0] ?? exited
      ms = `error: ${reason}`
    }
    process.stdout.write(
      `${kind.padEnd(8)} ${side.padStart(5)} ${n.padStart(6)} ${r.padStart(7)} ${zoom.padStart(5)}   ${ms}\n`,
    )
  }
}
