// The routing boundary measured on Node, in real Chromium and, where the
// toolchain is installed, in workerd (QR-22b): one bundle of
// src/test-utils/wasm/route-layout-boundary.ts, so every runtime executes the
// same code with no vitest alias in it (an alias would turn the TypeScript
// baseline into Rust). Needs the staged wasm artifact.
//
//   node packages/canvas-render/scripts/route-layout-boundary.mjs [--rounds=9] [--runtime=node,chromium,workerd] [--json=path]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..')
const artifacts = resolve(pkg, '../core-wasm/artifacts')
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const rounds = Number(args.rounds ?? 9)
const batchMs = Number(args['batch-ms'] ?? 50)
const runtimes = (args.runtime ?? 'node,chromium,workerd').split(',')

const entry = `
import * as glue from ${JSON.stringify(join(artifacts, 'whiteboard_wasm.js'))}
import { coreFrom } from '@kamiazya/whiteboard-core-wasm'
import { formatBoundary, instrumentGlue, measureBoundary } from ${JSON.stringify(join(pkg, 'src/test-utils/wasm/route-layout-boundary.ts'))}
export function run(source, runtime, rounds, batchMs) {
  const instrumented = instrumentGlue(glue)
  const core = coreFrom(instrumented.glue, source)
  const results = measureBoundary({ core, instrumented, now: () => performance.now(), rounds, batchMs })
  return { runtime, results, table: formatBoundary(runtime, results) }
}
`
const outDir = mkdtempSync(join(tmpdir(), 'route-layout-boundary-'))
const entryFile = join(outDir, 'entry.mjs')
writeFileSync(entryFile, entry)
const result = await build({
  root: pkg,
  logLevel: 'warn',
  configFile: false,
  resolve: {
    alias: {
      '@kamiazya/whiteboard-core-wasm': resolve(pkg, '../core-wasm/src/index.ts'),
      // The corpus wants one node builder; the barrel also carries fast-check and fake timers,
      // which a worker refuses to start with (no timers at global scope).
      '@kamiazya/whiteboard-model/test-utils': resolve(pkg, '../model/src/test-utils/nodes.ts'),
    },
  },
  build: {
    write: false,
    minify: false,
    target: 'es2022',
    lib: { entry: entryFile, formats: ['es'], fileName: 'bundle' },
    rollupOptions: { output: { codeSplitting: false } },
  },
})
const out = (Array.isArray(result) ? result[0] : result).output[0].code
const bundle = join(outDir, 'bundle.mjs')
writeFileSync(bundle, out)
const wasmBytes = readFileSync(join(artifacts, 'whiteboard_wasm_bg.wasm'))
const all = []

if (runtimes.includes('node')) {
  const { run } = await import(pathToFileURL(bundle).href)
  all.push(run(wasmBytes, `node ${process.version}`, rounds, batchMs))
}

if (runtimes.includes('chromium')) {
  const { createRequire } = await import('node:module')
  const { chromium } = createRequire(import.meta.url)('playwright')
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto('about:blank')
  // A module script cannot take a bare `export`, so the bundle is evaluated as a blob module.
  const answer = await page.evaluate(
    async ({ code, bytes, rounds, batchMs }) => {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      const { run } = await import(url)
      const r = run(new Uint8Array(bytes), 'chromium', rounds, batchMs)
      return r
    },
    { code: out, bytes: [...wasmBytes], rounds, batchMs },
  )
  answer.runtime = `chromium ${browser.version()}`
  answer.table = answer.table.replace(/^chromium:/, `${answer.runtime}:`)
  all.push(answer)
  await browser.close()
}

if (runtimes.includes('workerd')) {
  // workerd takes a compiled module as a binding (it will not compile bytes at runtime),
  // so the artifact is embedded as a `wasm` module and handed to the same entry.
  const bin = args.workerd ?? process.env.WORKERD ?? 'workerd'
  const dir = mkdtempSync(join(tmpdir(), 'route-layout-workerd-'))
  const port = Number(args.port ?? 8799)
  writeFileSync(join(dir, 'bundle.mjs'), out)
  writeFileSync(join(dir, 'whiteboard_wasm_bg.wasm'), wasmBytes)
  writeFileSync(
    join(dir, 'worker.mjs'),
    `import wasm from './whiteboard_wasm_bg.wasm'
import { run } from './bundle.mjs'
export default {
  fetch(req) {
    const q = new URL(req.url).searchParams
    return Response.json(run(wasm, 'workerd', Number(q.get('rounds')), Number(q.get('batchMs'))))
  },
}
`,
  )
  writeFileSync(
    join(dir, 'config.capnp'),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = (
    compatibilityDate = "2026-11-01",
    modules = [
      (name = "worker.mjs", esModule = embed "worker.mjs"),
      (name = "bundle.mjs", esModule = embed "bundle.mjs"),
      (name = "whiteboard_wasm_bg.wasm", wasm = embed "whiteboard_wasm_bg.wasm"),
    ],
  ))],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
`,
  )
  const { spawn } = await import('node:child_process')
  const child = spawn(bin, ['serve', join(dir, 'config.capnp')], { stdio: 'inherit' })
  try {
    let answer
    for (let attempt = 0; attempt < 50 && answer === undefined; attempt++) {
      await new Promise((r) => setTimeout(r, 200))
      try {
        const res = await fetch(`http://127.0.0.1:${port}/?rounds=${rounds}&batchMs=${batchMs}`)
        answer = await res.json()
      } catch (err) {
        if (child.exitCode !== null) throw err
      }
    }
    if (answer === undefined) throw new Error('workerd did not answer')
    answer.runtime = `workerd ${await new Promise((r) => {
      const v = spawn(bin, ['--version'])
      let t = ''
      v.stdout.on('data', (d) => (t += d))
      v.on('close', () => r(t.trim().replace(/^workerd /, '')))
    })}`
    answer.table = answer.table.replace(/^workerd:/, `${answer.runtime}:`)
    all.push(answer)
  } finally {
    child.kill()
  }
}

for (const r of all) console.log(`${r.table ?? r.skipped}\n`)
if (args.json) writeFileSync(args.json, JSON.stringify(all, null, 2))
