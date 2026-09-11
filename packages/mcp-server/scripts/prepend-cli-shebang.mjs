// Prepends the Node shebang to dist/cli/index.js. The bundler's `banner`
// applies to every output file, so it is done here instead.
//
// This script used to have a second job: re-injecting an auto-run side effect
// into the built MCP entry, because code splitting moved the source's
// `isDirectEntryPoint(import.meta.url)` guard into a chunk where the
// comparison against argv[1] could never be true. That workaround is gone
// along with the guard — `src/server/mcp/stdio.ts` is nothing but an
// unconditional `main()` call, so there is no decision left for a bundler to
// relocate and nothing to glue back on afterwards.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHEBANG = '#!/usr/bin/env node\n'
const here = dirname(fileURLToPath(import.meta.url))

const cliEntry = resolve(here, '..', 'dist', 'cli', 'index.js')
const cliSource = await readFile(cliEntry, 'utf8')
if (!cliSource.startsWith('#!')) {
  await writeFile(cliEntry, SHEBANG + cliSource)
}
