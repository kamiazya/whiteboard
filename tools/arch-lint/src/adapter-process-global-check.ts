import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isAdapterSource } from './adapter-files.js'
import { walk } from './scan-roots.js'
import { findScopeDefaultedCalls } from './scope-default-calls.js'
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

/**
 * The trees whose code is ADAPTING or WIRING a keeper rather than being one:
 * the routes and MCP registrations, the export and search helpers they and the
 * container reach for, and the few files at the top of `server/` that hand a
 * keeper's directory on (`app.ts` to its routers, `shared-background-work.ts`
 * to its workers, `workspace-handle.ts` to nine routes). `export/` and
 * `search/` were outside the population while each still read the process
 * directory for itself, and so did the shared workers — which is how backups
 * came to copy a different directory from the one the routes served.
 *
 * The roots (`http-server.ts`, `server-mode-http.ts`) are scanned for
 * scope-defaulting calls but not for `getDataDir(`: choosing the directory
 * once is what a root is for.
 */
// Wider than `adapter-files.ts`'s population on purpose: that one answers
// ADR-0018's "what is an adapter"; this scan also reads the helpers and the
// top-level files a keeper's directory passes THROUGH.
const ADAPTER_DIRS = ['routes', 'mcp', 'export', 'search'] as const
const ADAPTER_FILES = ['app.ts', 'shared-background-work.ts', 'workspace-handle.ts'] as const
const ROOT_FILES = ['http-server.ts', 'server-mode-http.ts'] as const

function adapterFiles(serverDir: string, extra: readonly string[] = []): string[] {
  const files: string[] = []
  for (const base of ADAPTER_DIRS) {
    const dir = join(serverDir, base)
    if (existsSync(dir)) files.push(...walk(dir, { include: isAdapterSource }))
  }
  for (const name of [...ADAPTER_FILES, ...extra]) {
    const file = join(serverDir, name)
    if (existsSync(file)) files.push(file)
  }
  return files
}

/**
 * Every `<adapter file> -> <process global>` read in the adapter population,
 * as the ledger spells it. Comments and string bodies are stripped first, so
 * prose naming a global is not a read.
 *
 * `serverDir` is `packages/mcp-server/src/server`.
 */
export function findAdapterGlobalReads(serverDir: string): string[] {
  const reads = new Set<string>()
  for (const file of adapterFiles(serverDir)) {
    const code = stripCommentsAndStrings(readFileSync(file, 'utf8'))
    const from = relative(serverDir, file).split('\\').join('/')
    for (const { name, pattern } of PROCESS_GLOBALS) {
      if (pattern.test(code)) reads.add(`${from} -> ${name}`)
    }
  }
  return [...reads].sort()
}

/**
 * Every `<file> -> <store export>` where the adapter population or a root
 * calls (or hands on) a `store/` export that defaults to the PROCESS's data
 * directory, without passing the scope it serves. See `scope-default-calls.ts`
 * for how the exports are derived and what counts as a call.
 *
 * `srcDir` is `packages/mcp-server/src`.
 */
export function findAdapterScopeDefaults(srcDir: string): string[] {
  const serverDir = join(srcDir, 'server')
  return findScopeDefaultedCalls(srcDir, adapterFiles(serverDir, ROOT_FILES))
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
