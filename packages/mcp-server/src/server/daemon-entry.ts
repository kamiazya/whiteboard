#!/usr/bin/env node
// The development daemon's process entry, and nothing else — the counterpart
// to `mcp/stdio.ts`, for the same reason. The package's `daemon` scripts start
// this file, so a bundler that hoisted the startup call into a shared chunk
// would leave them starting a process that exits without ever listening. The
// packaged `whiteboard daemon run` does NOT come through here: it calls
// `startHttpServer` in-process (`cli/daemon-run.ts`), so anything a deployment
// needs must live in the root, not in `main()`.
//
// `index.ts` stays importable: its own test imports it to call `main()`
// directly, and a module that starts an HTTP listener at import time squats a
// port for every other test in the run.
import { main } from './index.js'

main().catch((err) => {
  process.stderr.write(`HTTP server error: ${err}\n`)
  process.exit(1)
})
