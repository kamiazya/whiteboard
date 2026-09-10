#!/usr/bin/env node
// The HTTP daemon's process entry, and nothing else — the counterpart to
// `mcp/stdio.ts`, for the same reason. `ensure-daemon.ts` spawns this file, so
// a bundler that hoisted the startup call into a shared chunk would leave the
// daemon spawning a process that exits without ever listening.
//
// `index.ts` stays importable: its own test imports it to call `main()`
// directly, and a module that starts an HTTP listener at import time squats a
// port for every other test in the run.
import { main } from './index.js'

main().catch((err) => {
  process.stderr.write(`HTTP server error: ${err}\n`)
  process.exit(1)
})
