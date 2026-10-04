import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from '@typescript/typescript6'
import { adapterFiles } from './adapter-files.js'
import { parseSource, unwrapExpression } from './ast-helpers.js'
import { collectModuleSpecifiers } from './scanner.js'

/**
 * The ways an adapter can do a mechanic's job without importing one: reading
 * or writing the disk, asking the operating system, spawning a process, or
 * reading the environment. ADR-0018's edge scan sees an import of a mechanic
 * MODULE; an adapter that calls `writeFile` itself has welded an operation to
 * its storage just as surely, and no import of anything under `store/` shows it.
 *
 * Named as the ledger spells them. `node:fs/promises` and `node:fs` are one
 * kind, because what matters is that the file touches the disk. A SQL driver
 * (`kysely`, `libsql`, `@libsql/*`) is the same reach by another door: it opens
 * a database file without naming `node:fs`.
 */
export type HostReachKind =
  | 'node:fs'
  | 'node:os'
  | 'node:child_process'
  | 'node:process'
  | 'process.env'
  | 'storage-driver'

function kindOfSpecifier(specifier: string): HostReachKind | undefined {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  const root = bare.split('/')[0]
  if (root === 'fs') return 'node:fs'
  if (root === 'os') return 'node:os'
  if (root === 'child_process') return 'node:child_process'
  if (root === 'process') return 'node:process'
  if (specifier === 'kysely' || specifier === 'libsql' || specifier.startsWith('@libsql/')) {
    return 'storage-driver'
  }
  return undefined
}

/** The module a `process` binding can be imported from. */
function isProcessModule(specifier: string): boolean {
  return specifier === 'node:process' || specifier === 'process'
}

/** The name a property or string-key access reads, if it reads one. */
function accessedName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text
  }
  return undefined
}

/** A key as written: `env`, `'env'` or `"env"`. */
function keyText(name: ts.Node | undefined): string | undefined {
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
    ? name.text
    : undefined
}

/** Whether an expression is the `process` object: a binding of it, or `<anything>.process`. */
function isProcessObject(expression: ts.Expression, bindings: ReadonlySet<string>): boolean {
  const inner = unwrapExpression(expression)
  return ts.isIdentifier(inner) ? bindings.has(inner.text) : accessedName(inner) === 'process'
}

/** The names an import of `node:process` binds the object to, if the declaration is one. */
function importedProcessNames(node: ts.Node): string[] {
  if (
    !ts.isImportDeclaration(node) ||
    !ts.isStringLiteralLike(node.moduleSpecifier) ||
    !isProcessModule(node.moduleSpecifier.text) ||
    node.importClause === undefined ||
    node.importClause.isTypeOnly
  ) {
    return []
  }
  const { name, namedBindings } = node.importClause
  return [
    name,
    namedBindings && ts.isNamespaceImport(namedBindings) ? namedBindings.name : undefined,
  ]
    .filter((id): id is ts.Identifier => id !== undefined)
    .map((id) => id.text)
}

/** The local names a file binds the `process` object to: a default or namespace import, or a `const p = process`. */
function processBindings(source: ts.SourceFile): Set<string> {
  const names = new Set<string>(['process'])
  let grown = true
  while (grown) {
    const before = names.size
    const visit = (node: ts.Node): void => {
      for (const name of importedProcessNames(node)) names.add(name)
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        isProcessObject(node.initializer, names)
      ) {
        names.add(node.name.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    grown = names.size > before
  }
  return names
}

/** `{ env }` or `{ env: e }` taken from the process object, by declaration or by assignment. */
function destructuresEnv(node: ts.Node, bindings: ReadonlySet<string>): boolean {
  if (
    ts.isBindingElement(node) &&
    ts.isObjectBindingPattern(node.parent) &&
    ts.isVariableDeclaration(node.parent.parent)
  ) {
    const { initializer } = node.parent.parent
    return (
      keyText(node.propertyName ?? node.name) === 'env' &&
      initializer !== undefined &&
      isProcessObject(initializer, bindings)
    )
  }
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isObjectLiteralExpression(node.left) &&
    isProcessObject(node.right, bindings) &&
    node.left.properties.some((property) => keyText(property.name) === 'env')
  )
}

/** `import { env } from 'node:process'`. */
function importsEnv(node: ts.Node): boolean {
  if (!ts.isImportSpecifier(node) || node.isTypeOnly || node.parent.parent.isTypeOnly) return false
  const declaration = node.parent.parent.parent
  return (
    keyText(node.propertyName ?? node.name) === 'env' &&
    ts.isStringLiteralLike(declaration.moduleSpecifier) &&
    isProcessModule(declaration.moduleSpecifier.text)
  )
}

/**
 * The environment, however it is reached: `process.env` or `process['env']`
 * (through any local binding of `process`, or `globalThis.process`), a
 * destructured `{ env }` of it, or `env` imported from `node:process`.
 */
function readsProcessEnv(source: ts.SourceFile): boolean {
  const bindings = processBindings(source)
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        accessedName(node) === 'env' &&
        isProcessObject(node.expression, bindings)) ||
      destructuresEnv(node, bindings) ||
      importsEnv(node)
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
  const source = parseSource(fileName, text)
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
