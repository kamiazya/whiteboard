import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { walk } from './scan-roots.js'
import { stripCommentsAndStrings } from './source-scan.js'

/**
 * Process globals an adapter must be handed rather than read: the data
 * directory, and the one tenant a self-hosted keeper has. Named as the edge
 * spells them.
 */
const PROCESS_GLOBALS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'getDataDir', pattern: /\bgetDataDir\s*\(/ },
  { name: 'SELF_HOST_TENANT_ID', pattern: /\bSELF_HOST_TENANT_ID\b/ },
]

const ADAPTER_DIRS = ['routes', 'mcp'] as const

// Tests and `_test-*` scaffolding build an app the way a root does, so what
// they read says nothing about an adapter.
function isAdapterSource(file: string): boolean {
  return file.endsWith('.ts') && !file.endsWith('.test.ts') && !/(^|[\\/])_test-/.test(file)
}

/**
 * Every `<adapter file> -> <process global>` read in `server/routes/**` and
 * `server/mcp/**`, as the ledger spells it. Comments and string bodies are
 * stripped first, so prose naming a global is not a read.
 *
 * `serverDir` is `packages/mcp-server/src/server`.
 */
export function findAdapterGlobalReads(serverDir: string): string[] {
  const reads = new Set<string>()
  for (const base of ADAPTER_DIRS) {
    for (const file of walk(join(serverDir, base), { include: isAdapterSource })) {
      const code = stripCommentsAndStrings(readFileSync(file, 'utf8'))
      const from = relative(serverDir, file).split('\\').join('/')
      for (const { name, pattern } of PROCESS_GLOBALS) {
        if (pattern.test(code)) reads.add(`${from} -> ${name}`)
      }
    }
  }
  return [...reads].sort()
}
