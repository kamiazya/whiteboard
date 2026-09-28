#!/usr/bin/env node
import { spawn } from 'node:child_process'
// The BUILT-artifact variant of `pnpm mcp:http:dev`: runs dist/ instead of
// watch-mode source, for checking the daemon as it ships. Without
// `pnpm build` first the bare `node dist/...` fails with a MODULE_NOT_FOUND
// that names no cause, so the prerequisite is checked and said out loud.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const entry = join(packageRoot, 'dist/server/daemon-entry.js')
if (!existsSync(entry)) {
  process.stderr.write(
    '[mcp:http] dist/server/daemon-entry.js is missing — this script runs the BUILT daemon; run `pnpm build` first (or use `pnpm mcp:http:dev` for watch-mode source).\n',
  )
  process.exit(1)
}
const child = spawn(process.execPath, [entry, '--token=whiteboard-dev'], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
