import ts from '@typescript/typescript6'
import { isShippedPath } from './source-scan.js'

/** A source file as the scan reads it. `path` is repo-relative and `/`-separated. */
export interface ScannedFile {
  readonly path: string
  readonly text: string
}

/** What an export declares, as far as the classification below needs to tell. */
type DeclarationKind = 'type' | 'function' | 'class' | 'enum' | 'const'

interface ExportDef {
  readonly name: string
  readonly path: string
  readonly kind: DeclarationKind
}

/**
 * Why a test-only export is, or is not, a problem, in the order the questions
 * are asked:
 *
 * - `dead`: not even its own file uses it, so only a test keeps it alive.
 * - `barrel-only`: a package entry re-exports it and nothing shipped imports
 *   it. The name is part of a published surface with no consumer, and the way
 *   out is dropping the re-export, which is a package-API decision rather than
 *   a test's reach into an internal.
 * - `shape`: a type, a SCREAMING_CASE constant or a `*Schema`, used in its own
 *   file and imported by the sibling test of that file. Exporting a declared
 *   shape so the test beside it can state its contract is what the export is
 *   for, so it needs no per-name line.
 * - `reached`: everything else, an internal a test reaches into — an
 *   extracted helper tested directly, or a symbol a test in another directory
 *   or package imports.
 */
export type TestOnlyClass = 'dead' | 'barrel-only' | 'shape' | 'reached'

export interface TestOnlyExport extends ExportDef {
  /** Uses of the name inside its own file, the declaration excluded. */
  readonly ownUses: number
  /** `<path>#<name>`, as the ledger spells it. */
  readonly key: string
  readonly class: TestOnlyClass
}

/**
 * Not shipped: every category but `shipped` — tests, their support files, and
 * the smoke, bench and doc-snapshot harnesses — since none ships, an export
 * only they use is test-only.
 */
export function isTestFile(path: string): boolean {
  return !isShippedPath(path)
}

/** A file whose exports are test scaffolding by name, or a tool that polices the repo. */
function isExemptDefiner(path: string): boolean {
  return (
    path.startsWith('tools/arch-lint/') ||
    path.startsWith('tools/checks/') ||
    /(^|[./-])test-helpers?\.[a-z]+$/.test(path)
  )
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.ts')) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

function isFunctionValue(node: ts.Expression | undefined): boolean {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
}

/** The names one top-level statement declares, when it is a named, non-default export. */
function exportedNames(statement: ts.Statement): { name: string; kind: DeclarationKind }[] {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
  const keywords = new Set(modifiers?.map((m) => m.kind))
  if (!keywords.has(ts.SyntaxKind.ExportKeyword) || keywords.has(ts.SyntaxKind.DefaultKeyword)) {
    return []
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name)
        ? [
            {
              name: declaration.name.text,
              kind: isFunctionValue(declaration.initializer)
                ? ('function' as const)
                : ('const' as const),
            },
          ]
        : [],
    )
  }
  let kind: DeclarationKind | undefined
  if (ts.isFunctionDeclaration(statement)) kind = 'function'
  else if (ts.isClassDeclaration(statement)) kind = 'class'
  else if (ts.isEnumDeclaration(statement)) kind = 'enum'
  else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
    kind = 'type'
  }
  const name =
    kind !== undefined && 'name' in statement
      ? (statement.name as ts.Identifier | undefined)
      : undefined
  return kind !== undefined && name !== undefined ? [{ name: name.text, kind }] : []
}

/** Non-default, named export declarations of a source file, one per declared name. */
function exportsOf(path: string, source: ts.SourceFile): ExportDef[] {
  return source.statements.flatMap((statement) =>
    exportedNames(statement).map(({ name, kind }) => ({ name, path, kind })),
  )
}

interface FileWords {
  /** Identifier occurrences, by name; a `from` re-export is not one. */
  readonly counts: Map<string, number>
  /** Names a `export { x } from` re-export forwards, which is publishing rather than using. */
  readonly reexported: Set<string>
}

/**
 * Identifier occurrences in one file, by name, and the names it only re-exports.
 *
 * `export { x } from './y'` re-exports are skipped: a barrel naming a symbol
 * is not a use of it, and counting one would make every barrel export look
 * consumed. A local `export { x }` is a use of `x`, like any other mention.
 */
function wordsOf(source: ts.SourceFile): FileWords {
  const counts = new Map<string, number>()
  const reexported = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          reexported.add((element.propertyName ?? element.name).text)
        }
      }
      return
    }
    if (ts.isIdentifier(node)) counts.set(node.text, (counts.get(node.text) ?? 0) + 1)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { counts, reexported }
}

/** An `import(...)` call, or `vi.importActual(...)`, looked through `await` and parentheses. */
function isDynamicImport(node: ts.Node): boolean {
  let inner = node
  while (ts.isAwaitExpression(inner) || ts.isParenthesizedExpression(inner))
    inner = inner.expression
  if (!ts.isCallExpression(inner)) return false
  const callee = inner.expression
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'importActual'
}

/** `const mod = await import(...)` makes `mod` a namespace, whichever test body declares it. */
function addDynamicNamespaces(source: ts.SourceFile, namespaces: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isDynamicImport(node.initializer)
    ) {
      namespaces.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

function addImportDeclarationNames(
  statement: ts.ImportDeclaration,
  names: Set<string>,
  namespaces: Set<string>,
): void {
  const bindings = statement.importClause?.namedBindings
  if (bindings === undefined) return
  if (ts.isNamespaceImport(bindings)) {
    namespaces.add(bindings.name.text)
    return
  }
  for (const element of bindings.elements) names.add((element.propertyName ?? element.name).text)
}

function addReexportNames(statement: ts.ExportDeclaration, names: Set<string>): void {
  const clause = statement.exportClause
  if (statement.moduleSpecifier === undefined || clause === undefined) return
  if (!ts.isNamedExports(clause)) return
  for (const element of clause.elements) names.add((element.propertyName ?? element.name).text)
}

/** `ns.name` and `(await import(...)).name`. */
function memberOfImport(node: ts.Node, namespaces: ReadonlySet<string>): string[] {
  if (!ts.isPropertyAccessExpression(node)) return []
  const owner = node.expression
  const fromImport = ts.isIdentifier(owner) ? namespaces.has(owner.text) : isDynamicImport(owner)
  return fromImport ? [node.name.text] : []
}

/** `const { a, b: c } = await import(...)` binds `a` and `b`. */
function destructuredFromImport(node: ts.Node): string[] {
  if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name)) return []
  if (node.initializer === undefined || !isDynamicImport(node.initializer)) return []
  return node.name.elements.flatMap((element) => {
    const imported = element.propertyName ?? element.name
    return ts.isIdentifier(imported) ? [imported.text] : []
  })
}

/** `typeof import('./x').T`'s `T`. */
function qualifiedImportType(node: ts.Node): string[] {
  if (!ts.isImportTypeNode(node) || node.qualifier === undefined) return []
  const { qualifier } = node
  return [ts.isIdentifier(qualifier) ? qualifier.text : qualifier.right.text]
}

/**
 * The names a test file binds from another module: a named import (under the
 * name the exporter gave it), a `from` re-export, a member of a namespace
 * import, and the destructured or dotted result of a dynamic `import()`.
 *
 * A name that only appears in the text — a title, a comment, a string, the
 * ledger spelling `path#name` — binds nothing, and reading it as a use is how
 * a name no test imports stayed on the books. Methods called on an instance
 * the test built are not imports either, which is why a class is judged by the
 * import of the class itself.
 */
function importedNames(path: string, text: string): Set<string> {
  const names = new Set<string>()
  const namespaces = new Set<string>()
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path))
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) addImportDeclarationNames(statement, names, namespaces)
    else if (ts.isExportDeclaration(statement)) addReexportNames(statement, names)
  }
  // Only a file that can reach a member some other way pays for a full walk.
  const dynamic = text.includes('import(') || text.includes('importActual')
  if (namespaces.size === 0 && !dynamic) return names
  if (dynamic) addDynamicNamespaces(source, namespaces)
  const visit = (node: ts.Node): void => {
    for (const name of [
      ...memberOfImport(node, namespaces),
      ...destructuredFromImport(node),
      ...qualifiedImportType(node),
    ]) {
      names.add(name)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/** A file's own tests sit in its directory and start with its stem and a dot, whatever the suffix after it (`.test`, `.property.test`, `.browser.test`). */
function isSiblingTest(definer: string, test: string): boolean {
  const split = (path: string): [string, string] => {
    const slash = path.lastIndexOf('/')
    return [path.slice(0, slash), path.slice(slash + 1)]
  }
  const [definerDir, definerFile] = split(definer)
  const [testDir, testFile] = split(test)
  const stem = definerFile.replace(/\.[a-z]+$/, '')
  return definerDir === testDir && testFile.startsWith(`${stem}.`)
}

function isShapeDeclaration({ kind, name }: ExportDef): boolean {
  if (kind === 'type') return true
  return kind === 'const' && (/^[A-Z][A-Z0-9_]*$/.test(name) || name.endsWith('Schema'))
}

interface ReadFiles {
  readonly production: Map<string, Set<string>>
  readonly reexported: Set<string>
  readonly testImporters: Map<string, Set<string>>
  readonly defs: (ExportDef & { counts: Map<string, number> })[]
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const held = map.get(key) ?? new Set<string>()
  held.add(value)
  map.set(key, held)
}

function readFiles(files: readonly ScannedFile[]): ReadFiles {
  const read: ReadFiles = {
    production: new Map(),
    reexported: new Set(),
    testImporters: new Map(),
    defs: [],
  }
  for (const { path, text } of files) {
    if (isTestFile(path)) {
      for (const name of importedNames(path, text)) addTo(read.testImporters, name, path)
      continue
    }
    // No parent pointers: nothing here walks upward, and they are most of the cost of a parse.
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path))
    const words = wordsOf(source)
    for (const name of words.counts.keys()) addTo(read.production, name, path)
    for (const name of words.reexported) read.reexported.add(name)
    if (!/(^|\/)src\//.test(path) || isExemptDefiner(path)) continue
    for (const def of exportsOf(path, source)) read.defs.push({ ...def, counts: words.counts })
  }
  return read
}

/**
 * Exports of shipped source under `*\/src/` that no other shipped file uses and
 * some test imports.
 *
 * Knip counts a test's import as a use, so a symbol kept alive only by its own
 * test is invisible to it. The method errs toward false negatives on purpose:
 * a same-named identifier in ANY other shipped file counts as production use,
 * so a flagged name is one nothing else shipped even spells. A test uses a
 * name only by binding it (`importedNames`), so a name a test merely mentions
 * is not counted. `ownUses` separates "no use at all, even in its own file"
 * from "exported so its test can reach an internal", and `class` says which
 * kind of problem the remaining ones are.
 */
export function findTestOnlyExports(files: readonly ScannedFile[]): TestOnlyExport[] {
  const { production, reexported, testImporters, defs } = readFiles(files)
  const classify = (def: ExportDef, ownUses: number): TestOnlyClass => {
    if (ownUses === 0) return 'dead'
    if (reexported.has(def.name)) return 'barrel-only'
    const importers = testImporters.get(def.name) ?? new Set<string>()
    const siblingImports = [...importers].some((test) => isSiblingTest(def.path, test))
    return siblingImports && isShapeDeclaration(def) ? 'shape' : 'reached'
  }
  return defs
    .filter(({ name }) => !/(ForTests|_FOR_TESTS)$/.test(name) && !name.startsWith('_'))
    .filter(({ name, path }) => {
      const holders = production.get(name)
      const usedElsewhere = holders !== undefined && [...holders].some((holder) => holder !== path)
      return !usedElsewhere && testImporters.has(name)
    })
    .map(({ counts, ...def }) => {
      const ownUses = (counts.get(def.name) ?? 1) - 1
      return { ...def, ownUses, key: `${def.path}#${def.name}`, class: classify(def, ownUses) }
    })
}
