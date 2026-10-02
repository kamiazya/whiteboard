import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from '@typescript/typescript6'
import { adapterFiles } from './adapter-files.js'
import { collectModuleSpecifiers } from './scanner.js'

/**
 * The ways an adapter can do a mechanic's job without importing one: reading
 * or writing the disk, asking the operating system, spawning a process, or
 * reading the environment. ADR-0018's edge scan sees an import of a mechanic
 * MODULE; an adapter that calls `writeFile` itself has welded an operation to
 * its storage just as surely, and no import of anything under `store/` shows it.
 *
 * Named as the ledger spells them. `node:fs/promises` and `node:fs` are one
 * kind, because what matters is that the file touches the disk.
 */
type HostReachKind = 'node:fs' | 'node:os' | 'node:child_process' | 'process.env'

function kindOfSpecifier(specifier: string): HostReachKind | undefined {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  const root = bare.split('/')[0]
  if (root === 'fs') return 'node:fs'
  if (root === 'os') return 'node:os'
  if (root === 'child_process') return 'node:child_process'
  return undefined
}

/** `process.env`, however it is then indexed. */
function readsProcessEnv(source: ts.SourceFile): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      node.name.text === 'env'
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** The kinds of host reach one source text contains. Type-only imports are erased and do not count. */
export function hostReachOf(fileName: string, text: string): Set<HostReachKind> {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const kinds = new Set<HostReachKind>()
  for (const { specifier, typeOnly } of collectModuleSpecifiers(source)) {
    const kind = kindOfSpecifier(specifier)
    if (kind !== undefined && !typeOnly) kinds.add(kind)
  }
  if (readsProcessEnv(source)) kinds.add('process.env')
  return kinds
}

/**
 * Every `<adapter file> -> <kind>` in the adapter population (routes and MCP
 * registrations, as `adapter-files.ts` defines them, plus the helper files
 * named by `ADAPTER_HELPER_FILES`, which every route that calls one shares),
 * sorted.
 *
 * `serverDir` is `packages/mcp-server/src/server`.
 */
export function findAdapterHostReach(
  serverDir: string,
  helperFiles: readonly string[] = [],
): string[] {
  const reach = new Set<string>()
  const files = [
    ...adapterFiles(serverDir),
    ...helperFiles.map((helper) => join(serverDir, helper)),
  ]
  for (const file of files) {
    const from = relative(serverDir, file).split('\\').join('/')
    for (const kind of hostReachOf(file, readFileSync(file, 'utf8')))
      reach.add(`${from} -> ${kind}`)
  }
  return [...reach].sort()
}
