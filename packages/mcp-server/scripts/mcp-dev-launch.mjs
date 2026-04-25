#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const loaderPath = resolve(packageRoot, 'node_modules/tsx/dist/loader.mjs')
const entryPath = resolve(packageRoot, 'src/server/mcp/index.ts')

const child = spawn(process.execPath, ['--import', loaderPath, entryPath, ...process.argv.slice(2)], {
  cwd: packageRoot,
  env: process.env,
  stdio: 'inherit',
})

child.on('error', (error) => {
  process.stderr.write(`[mcp-dev-launch] failed to spawn MCP entry: ${error.message}\n`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
