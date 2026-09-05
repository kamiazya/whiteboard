#!/usr/bin/env node
import { spawn } from 'node:child_process'
// The BUILT-artifact variant of `pnpm mcp:http:dev`: runs dist/ instead of
// watch-mode source, for checking the daemon as it ships. Two traps this
// wrapper closes, both measured: run from a linked worktree, a hardcoded
// `--port=3099` bound the MAIN checkout's port with the shared dev token —
// the exact collision development.md built detection for — so the port is
// derived per checkout the same way mcp:http:dev derives it; and without
// `pnpm build` first the bare `node dist/...` fails with a MODULE_NOT_FOUND
// that names no cause, so the prerequisite is checked and said out loud.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveDevPort, isMainCheckout } from './dev-port-lib.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = join(packageRoot, 'dist/server/index.js')
if (!existsSync(entry)) {
  process.stderr.write(
    '[mcp:http] dist/server/index.js is missing — this script runs the BUILT daemon; run `pnpm build` first (or use `pnpm mcp:http:dev` for watch-mode source).\n',
  )
  process.exit(1)
}
const repoRoot = join(packageRoot, '../..')
const port = deriveDevPort({
  repoRoot,
  isMainCheckout: isMainCheckout(repoRoot),
  env: process.env,
})
const child = spawn(
  process.execPath,
  [entry, '--daemon', `--port=${port}`, '--token=whiteboard-dev'],
  { stdio: 'inherit' },
)
child.on('exit', (code) => process.exit(code ?? 1))
