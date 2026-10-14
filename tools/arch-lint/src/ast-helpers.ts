import ts from '@typescript/typescript6'

/** The parser mode a file's extension asks for: JSX is legal only in `.tsx` / `.jsx`. */
export function scriptKindOf(fileName: string): ts.ScriptKind {
  return /\.[tj]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/** A wrapper that changes an expression's type and not its value. */
export type TypeOnlyWrapper =
  | ts.ParenthesizedExpression
  | ts.AsExpression
  | ts.SatisfiesExpression
  | ts.NonNullExpression
  | ts.TypeAssertion

/**
 * Whether `node` is one of the wrappers `unwrapExpression` looks through.
 * Exposed for a walk UP from a node, which cannot use the downward helper and
 * must not keep its own list of the five.
 */
export function isTypeOnlyWrapper(node: ts.Node): node is TypeOnlyWrapper {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
}

/**
 * An expression with the wrappers that change its type and not its value looked
 * through: parentheses, `as`, `satisfies`, `<T>x` and `x!`. A guard that
 * skipped only some would judge `(save as Fn)(doc)` as something other than
 * the call it is.
 */
export function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node
  while (isTypeOnlyWrapper(current)) current = current.expression
  return current
}

/**
 * Parse `text` the way its file name asks. Parent pointers are on because most
 * walks read `node.parent`; a scan that never does may pass `false`, since
 * they are most of the cost of a parse. `kind` overrides the extension's
 * answer for source whose name does not say what it is (a `.js` script, a
 * fixture whose name hides that it carries JSX).
 */
export function parseSource(
  fileName: string,
  text: string,
  setParentNodes = true,
  kind: ts.ScriptKind = scriptKindOf(fileName),
): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, setParentNodes, kind)
}

/** One local name an import declaration binds. */
export interface ImportBinding {
  /** The name the importing file uses. */
  readonly local: string
  /** The export it binds: its name, `default` for a default import, `*` for a namespace import. */
  readonly imported: string
  /** `import { a }` / `import d` / `import * as ns`: `{ default as d }` is named, not default. */
  readonly kind: 'named' | 'default' | 'namespace'
  /** The module specifier as written. */
  readonly spec: string
  /** `import type …` or `import { type … }`: erased, so it reaches nothing at runtime. */
  readonly typeOnly: boolean
  /** The node that declares `local`, for a walk that resolves a name by lexical scope. */
  readonly node: ts.ImportSpecifier | ts.ImportClause | ts.NamespaceImport
}

/** Every local name one import declaration binds. A side-effect import binds none. */
export function bindingsOfImport(declaration: ts.ImportDeclaration): ImportBinding[] {
  const clause = declaration.importClause
  if (clause === undefined || !ts.isStringLiteralLike(declaration.moduleSpecifier)) return []
  const spec = declaration.moduleSpecifier.text
  const typeOnly = clause.isTypeOnly
  const bound: ImportBinding[] = []
  if (clause.name !== undefined) {
    bound.push({
      local: clause.name.text,
      imported: 'default',
      kind: 'default',
      spec,
      typeOnly,
      node: clause,
    })
  }
  const named = clause.namedBindings
  if (named !== undefined && ts.isNamespaceImport(named)) {
    bound.push({
      local: named.name.text,
      imported: '*',
      kind: 'namespace',
      spec,
      typeOnly,
      node: named,
    })
  } else if (named !== undefined) {
    for (const element of named.elements) {
      bound.push({
        local: element.name.text,
        imported: (element.propertyName ?? element.name).text,
        kind: 'named',
        spec,
        typeOnly: typeOnly || element.isTypeOnly,
        node: element,
      })
    }
  }
  return bound
}

/** Every local name the file's top-level imports bind, in source order. */
export function importBindingsOf(file: ts.SourceFile): ImportBinding[] {
  return file.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) ? bindingsOfImport(statement) : [],
  )
}

export interface ImportedBindingsOptions {
  /**
   * The module is CommonJS-shaped (`node:fs`, `node:process`,
   * `node:timers/promises`): its default import IS the whole module, so
   * `import fs from 'node:fs'; fs.rename(…)` reaches the export. Off for an
   * ES module, whose default is one export among others.
   */
  readonly defaultIsNamespace?: boolean
  /** Count `import type` bindings too. Off by default: a type-only binding is erased. */
  readonly includeTypeOnly?: boolean
}

export interface ImportedBindings {
  /** Local name -> the node that binds it to the export itself. */
  readonly locals: ReadonlyMap<string, ts.Node>
  /** Local name -> the node that binds it to the whole module, so `name.<export>` reaches it. */
  readonly namespaces: ReadonlyMap<string, ts.Node>
  /**
   * The names `export { <export> as name } from` forwards it under. They bind
   * nothing in this file, and are the door a reach through a barrel takes.
   * `export * from` is not resolved: that needs the target's export list.
   */
  readonly reexports: ReadonlySet<string>
}

/** The specifiers of `export { … } from <module>`, when `statement` is one; type-only ones on request. */
function forwardingSpecifiers(
  statement: ts.Statement,
  isModule: (spec: string) => boolean,
  includeTypeOnly: boolean,
): readonly ts.ExportSpecifier[] {
  if (!ts.isExportDeclaration(statement) || (statement.isTypeOnly && !includeTypeOnly)) return []
  const { exportClause: clause, moduleSpecifier: spec } = statement
  if (clause === undefined || !ts.isNamedExports(clause) || spec === undefined) return []
  if (!ts.isStringLiteralLike(spec) || !isModule(spec.text)) return []
  return clause.elements.filter((element) => includeTypeOnly || !element.isTypeOnly)
}

/** `export { <wanted> as name } from <module>`'s `name`s. */
function forwardedNames(
  file: ts.SourceFile,
  isModule: (spec: string) => boolean,
  wanted: (name: string) => boolean,
  includeTypeOnly: boolean,
): Set<string> {
  const names = new Set<string>()
  for (const statement of file.statements) {
    for (const element of forwardingSpecifiers(statement, isModule, includeTypeOnly)) {
      if (wanted((element.propertyName ?? element.name).text)) names.add(element.name.text)
    }
  }
  return names
}

/**
 * The local names `file` binds an export of a module to: named, aliased,
 * through a namespace, or (`defaultIsNamespace`) through a default import,
 * plus the names it re-exports it under. One answer to "which local name is
 * the import of X", because every guard that wrote its own had accepted a
 * different subset of the spellings, and a spelling a guard cannot resolve
 * is a call it reports clean.
 */
export function importedBindings(
  file: ts.SourceFile,
  isModule: (spec: string) => boolean,
  exportName: string | ReadonlySet<string>,
  options: ImportedBindingsOptions = {},
): ImportedBindings {
  const wanted = (name: string) =>
    typeof exportName === 'string' ? name === exportName : exportName.has(name)
  const locals = new Map<string, ts.Node>()
  const namespaces = new Map<string, ts.Node>()
  for (const binding of importBindingsOf(file)) {
    if (!isModule(binding.spec) || (binding.typeOnly && options.includeTypeOnly !== true)) continue
    const wholeModule =
      binding.kind === 'namespace' || (binding.kind === 'default' && options.defaultIsNamespace)
    if (wholeModule) namespaces.set(binding.local, binding.node)
    else if (wanted(binding.imported)) locals.set(binding.local, binding.node)
  }
  const reexports = forwardedNames(file, isModule, wanted, options.includeTypeOnly === true)
  return { locals, namespaces, reexports }
}
