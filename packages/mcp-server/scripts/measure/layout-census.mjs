/**
 * Which whole layouts the Rust core does NOT answer, and why, counted by
 * class over a representative corpus (ADR-0054 step 7). Every layout goes
 * through canvas-render's switch under `differential`, whose sink reports a
 * layout the request gate skipped (`skipped:<class>`, before the core is
 * asked) and one the core declined (`declined:<class>`); the rest the core
 * answered and was compared.
 *
 * Run (from packages/mcp-server, which carries tsx):
 *   node --import tsx/esm scripts/measure/layout-census.mjs [--json=path]
 *
 * The profiles, each bounded:
 *   recorded  the whole-layout recordings' cases (`layout-cases.ts`: the
 *             composer recordings' boards, bodies aimed at the typesetter,
 *             the routing corpus), each under its own options.
 *   daemon    what `wb_scene_render` hands the layout by default (the
 *             daemon's export measurer, the light bundled theme, the clean
 *             style, no comment layer) over the composer recordings' boards,
 *             the drawing corpus, the canvases under docs/assets, and every
 *             Markdown file under docs/ and skills/ as one text node.
 *   proposals the daemon profile's options with each board's proposals drawn,
 *             over the compose-comments recording's proposal boards (every
 *             arm, a crowd, conflicts). No daemon path draws proposals
 *             today (`wb_scene_render` takes none); the web editor does,
 *             and measures with a canvas context, so this is the nearest
 *             profile that reaches the core with a proposal layer; run
 *             again with the export's dark options.
 *   export    what the PNG/SVG file export (`/export`, `/export-svg`) hands
 *             the layout, in its light and its dark mode, over the daemon
 *             profile's corpora: the options are the export's own
 *             (`exportLayoutOptions`), so the dark appearance and the
 *             measurer's `fontAvailable` are the ones the export passes.
 *
 * The web root is not run: it measures with a canvas context the core
 * cannot repeat, so every web layout skips as `measure` by construction.
 *
 * Exit 0: counted, nothing differed. Exit 1: a difference or a refusal.
 * Exit 2: the core did not load, so nothing was counted.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSpatialTheme, layoutSpatialCanvas } from '@kamiazya/whiteboard-canvas-render'
import { installSpatialCore, parseSpatial, spatialCoreInstalled } from '@kamiazya/whiteboard-codec'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { isRunAsScript } from '../../../../tools/checks/src/is-run-as-script.mjs'
import { boards } from '../../../canvas-render/src/test-utils/compose-canvas-oracle/corpus.ts'
import { DRAWING_CORPUS } from '../../../canvas-render/src/test-utils/drawing-corpus.ts'
import { proposalBoards } from '../../../canvas-render/src/test-utils/proposal-oracle/layer-corpus.ts'
import { layoutCases } from '../../../canvas-render/src/test-utils/wasm/layout-cases.ts'
import { exportLayoutOptions } from '../../src/server/export/headless-renderer.ts'
import { coreLoaders, layoutCoreSettingsFrom } from '../../src/server/export/layout-core.ts'
import { createExportTextMeasurer } from '../../src/server/export/measure-text.ts'

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')

/**
 * `base` switched to `differential` for the whole layout alone, its sink
 * keeping every report instead of logging it. `take` answers what the
 * reports since the last call say about one layout: its class, or
 * `answered` when the core was compared and agreed.
 */
export function tallyingCore(base) {
  let reports = []
  const core = {
    ...base,
    impl: { routeLayout: 'ts', layoutSpatialCanvas: 'differential' },
    onMismatch: (report) => reports.push(report),
  }
  const take = () => {
    const taken = reports
    reports = []
    const classes = taken.map((r) =>
      r.kind === 'skipped' || r.kind === 'declined' ? `${r.kind}:${r.reason}` : r.kind,
    )
    return classes.length === 0 ? ['answered'] : classes
  }
  return { core, take }
}

/** Every case laid out once through `core`, counted by class. */
export function censusOf({ core, take }, cases) {
  const counts = new Map()
  for (const { canvas, options } of cases) {
    layoutSpatialCanvas(canvas, { ...options, core })
    for (const name of take()) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return { layouts: cases.length, counts }
}

async function markdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

/** One board per Markdown file, its whole text as one node's body. */
async function markdownBoards() {
  const files = [
    ...(await markdownFiles(join(REPO, 'docs'))),
    ...(await markdownFiles(join(REPO, 'skills'))),
  ]
  return Promise.all(
    files.map(async (file) => ({
      name: relative(REPO, file),
      canvas: {
        nodes: [
          textNode({
            id: 'md',
            x: 0,
            y: 0,
            width: 480,
            height: 1200,
            text: await readFile(file, 'utf8'),
          }),
        ],
        edges: [],
      },
    })),
  )
}

async function docsCanvases() {
  const dir = join(REPO, 'docs', 'assets')
  const names = (await readdir(dir)).filter((name) => name.endsWith('.canvas')).sort()
  return Promise.all(
    names.map(async (name) => {
      const parsed = parseSpatial(await readFile(join(dir, name), 'utf8'))
      if (!parsed.ok) throw new Error(`${name} does not parse`)
      return { name: `docs/assets/${name}`, canvas: parsed.value }
    }),
  )
}

/** The daemon profile's corpora, each laid out as `wb_scene_render` lays a board out by default. */
async function daemonCorpora(options) {
  const asDaemon = (list) => list.map(({ name, canvas }) => ({ name, canvas, options }))
  return {
    'composer boards': asDaemon(boards()),
    'drawing corpus': asDaemon(DRAWING_CORPUS),
    'docs canvases': asDaemon(await docsCanvases()),
    'docs and skills markdown': asDaemon(await markdownBoards()),
  }
}

/** The boards carrying proposals, each laid out with the daemon profile's options and its proposals. */
function proposalCorpus(daemon) {
  return proposalBoards().map(({ name, canvas, proposals }) => ({
    name,
    canvas,
    options: { ...daemon, proposals },
  }))
}

/** The census of every corpus, or undefined when the core did not load. */
async function measureCensus() {
  const settings = layoutCoreSettingsFrom({ WHITEBOARD_CORE_MISMATCH: 'throw' })
  const base = await coreLoaders({
    ...settings,
    WHITEBOARD_CORE_LAYOUT: 'differential',
  }).layoutCore()
  if (base?.layout === undefined) return undefined
  if (!spatialCoreInstalled()) installSpatialCore(base.routing)
  const tallying = tallyingCore(base)
  const fontsDir = await mkdtemp(join(tmpdir(), 'wb-census-fonts-'))
  try {
    const { measure, measurableFamilies } = await createExportTextMeasurer({ fontsDir })
    const daemon = {
      measure,
      appearance: createSpatialTheme({ mode: 'light' }),
      commentLayer: false,
    }
    const fontAvailable = (family) => measurableFamilies.has(family)
    const exportCorpora = async (mode) =>
      Object.fromEntries(
        Object.entries(
          await daemonCorpora(exportLayoutOptions(measure, mode, undefined, fontAvailable)),
        ).map(([name, cases]) => [`export ${mode}: ${name}`, cases]),
      )
    const corpora = {
      recorded: layoutCases(20),
      ...(await daemonCorpora(daemon)),
      'proposals: proposal boards': proposalCorpus(daemon),
      'proposals dark: proposal boards': proposalCorpus(
        exportLayoutOptions(measure, 'dark', undefined, fontAvailable),
      ),
      ...(await exportCorpora('light')),
      ...(await exportCorpora('dark')),
    }
    return Object.fromEntries(
      Object.entries(corpora).map(([name, cases]) => [name, censusOf(tallying, cases)]),
    )
  } finally {
    await rm(fontsDir, { recursive: true, force: true })
  }
}

function print(census) {
  const classes = [...new Set(Object.values(census).flatMap((c) => [...c.counts.keys()]))].sort()
  const total = new Map()
  for (const [name, { layouts, counts }] of Object.entries(census)) {
    console.log(`${name} (${layouts} layouts)`)
    for (const cls of classes.filter((c) => counts.has(c))) {
      const n = counts.get(cls)
      total.set(cls, (total.get(cls) ?? 0) + n)
      console.log(
        `  ${cls.padEnd(28)} ${String(n).padStart(5)}  ${((100 * n) / layouts).toFixed(1)}%`,
      )
    }
  }
  const layouts = Object.values(census).reduce((n, c) => n + c.layouts, 0)
  console.log(`all (${layouts} layouts)`)
  for (const [cls, n] of [...total].sort()) {
    console.log(
      `  ${cls.padEnd(28)} ${String(n).padStart(5)}  ${((100 * n) / layouts).toFixed(1)}%`,
    )
  }
  return total
}

async function main() {
  const json = process.argv.find((a) => a.startsWith('--json='))?.slice('--json='.length)
  const census = await measureCensus()
  if (census === undefined) {
    console.log('the core did not load (pnpm stage:wasm), so nothing was counted')
    return 2
  }
  const total = print(census)
  if (json !== undefined) {
    const plain = Object.fromEntries(
      Object.entries(census).map(([k, v]) => [
        k,
        { layouts: v.layouts, counts: Object.fromEntries(v.counts) },
      ]),
    )
    await writeFile(json, `${JSON.stringify(plain, null, 2)}\n`)
  }
  return (total.get('differs') ?? 0) + (total.get('refused') ?? 0) > 0 ? 1 : 0
}

if (isRunAsScript(import.meta.url)) {
  let code = 1
  try {
    code = await main()
  } catch (err) {
    console.error(err)
  }
  process.exit(code)
}
