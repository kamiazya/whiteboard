// Post-build fixups for the tsup output.
//
// 1. Prepend the Node shebang to dist/cli/index.js — tsup's `banner` applies
//    to every output file, so we do it here instead.
// 2. Append the auto-run side effect to dist/server/mcp/index.js — tsup code
//    splitting moves implementation into chunks, leaving the entry as a thin
//    re-export wrapper. The `isDirectEntryPoint` guard + `main()` call that
//    the source file has at module scope gets lost in the chunk where
//    import.meta.url no longer matches the executed entry path.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHEBANG = '#!/usr/bin/env node\n'
const here = dirname(fileURLToPath(import.meta.url))

// --- 1. CLI shebang ---
const cliEntry = resolve(here, '..', 'dist', 'cli', 'index.js')
const cliSource = await readFile(cliEntry, 'utf8')
if (!cliSource.startsWith('#!')) {
  await writeFile(cliEntry, SHEBANG + cliSource)
}

// --- 2. MCP stdio auto-run ---
const mcpEntry = resolve(here, '..', 'dist', 'server', 'mcp', 'index.js')
const mcpSource = await readFile(mcpEntry, 'utf8')

const AUTO_RUN = `
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
const __entry = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return resolvePath(process.argv[1] ?? ''); } })();
if (__entry === (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return resolvePath(fileURLToPath(import.meta.url)); } })()) {
  main().catch((err) => { process.stderr.write(\`MCP server error: \${err}\\n\`); process.exit(1); });
}
`

if (!mcpSource.includes('__entry')) {
  await writeFile(
    mcpEntry,
    mcpSource.replace(/\/\/#\s*sourceMappingURL=.*$/, (sourceMap) => `${AUTO_RUN}${sourceMap}`),
  )
}
