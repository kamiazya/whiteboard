#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDevDataDirEnv, resolveRepoRootFromScriptDir } from './with-dev-data-dir-lib.mjs'

// Keeps dev daemons started via `pnpm mcp:http:dev` (and anything that
// shells out to it — mcp:debug:http, the SessionStart ensure-http-dev-daemon
// hook) out of the real ~/.whiteboard by default. A node wrapper (not a
// shell `VAR=x` prefix in package.json) so this stays correct on Windows.
const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '../..')
const repoRoot = resolveRepoRootFromScriptDir(scriptDir)
const env = resolveDevDataDirEnv(process.env, repoRoot)

// Shell out to the real tsx CLI (not node's --watch + --import loader) so
// this matches the exact restart/reload behavior of the pre-existing
// `tsx watch ...` package script.
const tsxBin = resolve(packageRoot, 'node_modules/.bin/tsx')
const entryPath = resolve(packageRoot, 'src/server/index.ts')

const child = spawn(tsxBin, ['watch', entryPath, ...process.argv.slice(2)], {
  cwd: packageRoot,
  env,
  stdio: 'inherit',
})

child.on('error', (error) => {
  process.stderr.write(`[with-dev-data-dir] failed to spawn dev server: ${error.message}\n`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
