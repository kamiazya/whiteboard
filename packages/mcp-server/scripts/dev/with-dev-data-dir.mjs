#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureDevDataDirSecured,
  resolveDevDataDirEnv,
  resolveRepoRootFromScriptDir,
  resolveTsxWatchSpawn,
} from './with-dev-data-dir-lib.mjs'

// Keeps dev daemons started via `pnpm mcp:http:dev` (and anything that
// shells out to it — mcp:debug:http, the SessionStart ensure-http-dev-daemon
// hook) out of the real ~/.whiteboard by default. A node wrapper (not a
// shell `VAR=x` prefix in package.json) so this stays correct on Windows.
const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '../..')
const repoRoot = resolveRepoRootFromScriptDir(scriptDir)
const hadExplicitDataDirOverride = Boolean(process.env.WHITEBOARD_DATA_DIR)
const env = resolveDevDataDirEnv(process.env, repoRoot)

// resolveDataDir() (shared/data-dir-secure.ts) only hardens permissions on
// its own home-directory default; an explicit WHITEBOARD_DATA_DIR — which is
// exactly what we just set below — short-circuits that and skips it
// entirely. Harden it ourselves, but only for the repo-local default we
// injected: a caller-provided override is respected as-is, same contract as
// resolveDataDir().
if (!hadExplicitDataDirOverride) {
  ensureDevDataDirSecured(env.WHITEBOARD_DATA_DIR)
}

// Shell out to the real tsx CLI (not node's --watch + --import loader) so
// this matches the exact restart/reload behavior of the pre-existing
// `tsx watch ...` package script. Spawns node directly against tsx's
// dist/cli.mjs rather than node_modules/.bin/tsx: that .bin entry is a POSIX
// shell shim (with separate .cmd/.ps1 wrappers on Windows), which `shell:
// false` cannot execute on native Windows.
const entryPath = resolve(packageRoot, 'src/server/index.ts')
const { command, args } = resolveTsxWatchSpawn(packageRoot, entryPath, process.argv.slice(2))

const child = spawn(command, args, {
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
