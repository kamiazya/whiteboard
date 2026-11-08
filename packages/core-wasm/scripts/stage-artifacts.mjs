#!/usr/bin/env node
// `pnpm --filter @kamiazya/whiteboard-core-wasm stage:wasm`: copy the
// artifact `pnpm rust:build:wasm` writes (`cargo xtask dist wasm`, then
// wasm-bindgen --target web) into this package's `artifacts/`, which the
// `#glue` import names. A copy and nothing else, so the size ledger and the
// reproducibility check keep measuring the one build path.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const here = join(import.meta.dirname, '..')
const from = join(here, '..', '..', 'target', 'dist', 'wasm-bindgen', 'whiteboard-wasm')
const to = join(here, 'artifacts')
const files = ['whiteboard_wasm.js', 'whiteboard_wasm.d.ts', 'whiteboard_wasm_bg.wasm']

const missing = files.filter((f) => !existsSync(join(from, f)))
if (missing.length > 0) {
  process.stderr.write(
    `stage:wasm: ${missing.join(', ')} not in ${from}; run \`pnpm rust:build:wasm\`\n`,
  )
  process.exit(1)
}
mkdirSync(to, { recursive: true })
for (const f of files) copyFileSync(join(from, f), join(to, f))
process.stdout.write(`stage:wasm: ${files.length} files into ${to}\n`)
