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

/**
 * `di/**` hands every store it builds one `StoreScope`; `globalStoreScope` is
 * the DEFAULT a store takes when nothing hands it one, and a composition that
 * names it has stopped saying which directory it serves.
 */
const COMPOSITION_GLOBALS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  ...PROCESS_GLOBALS,
  { name: 'globalStoreScope', pattern: /\bglobalStoreScope\b/ },
]

function isComposedSource(file: string): boolean {
  return isAdapterSource(file) && !/(^|[\\/])migrations[\\/]/.test(file)
}

/**
 * The same ledger for the layers that BUILD stores: `di/**` (as `di/<file>`)
 * and `server/store/**` (as `store/<file>`), where a read of the process data
 * dir or the self-host tenant is how a seam ends up serving a different
 * directory from the store beside it. Migrations are history and skipped.
 *
 * `srcDir` is `packages/mcp-server/src`. Inside `store/` only the data dir and
 * the tenant are read as globals: `globalStoreScope` is that layer's own
 * default parameter, which is the point of it.
 */
export function findCompositionGlobalReads(srcDir: string): string[] {
  const reads = new Set<string>()
  const trees = [
    { dir: join(srcDir, 'di'), globals: COMPOSITION_GLOBALS, label: 'di' },
    { dir: join(srcDir, 'server', 'store'), globals: PROCESS_GLOBALS, label: 'store' },
  ]
  for (const { dir, globals, label } of trees) {
    for (const file of walk(dir, { include: isComposedSource })) {
      const code = stripCommentsAndStrings(readFileSync(file, 'utf8'))
      const from = `${label}/${relative(dir, file).split('\\').join('/')}`
      for (const { name, pattern } of globals) {
        if (pattern.test(code)) reads.add(`${from} -> ${name}`)
      }
    }
  }
  return [...reads].sort()
}
