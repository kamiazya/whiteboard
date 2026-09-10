#!/usr/bin/env node
// The stdio MCP server's process entry, and nothing else.
//
// It is separate from `index.ts` for the reason `cli/index.ts` is separate from
// `dispatcher.ts`: a module that decides FOR ITSELF whether it is the process
// entry has to ask where it lives, and `import.meta.url` answers that with the
// CHUNK's location once a bundler moves the module. Measured under rolldown:
// the entry became a 127-byte re-export facade, the guard's comparison against
// argv[1] was never true, and the built server exited immediately instead of
// speaking stdio — with the build green and nothing to see in the diff.
//
// An entry that starts unconditionally cannot be wrong about being an entry.
// `index.ts` stays importable, which `server/app.ts` needs: it takes
// `createMcpServer` from there to compose the HTTP server, and must not get a
// stdio server as a side effect.
import { main } from './index.js'

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`)
  process.exit(1)
})
