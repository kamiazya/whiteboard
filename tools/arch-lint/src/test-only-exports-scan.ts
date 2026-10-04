import ts from '@typescript/typescript6'
import { scriptKindOf } from './ast-helpers.js'
import { createExportResolver, type ModuleExports } from './module-exports-resolve.js'
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

/** A script that is not TypeScript is parsed as plain JavaScript, where `<T>x` is not an assertion. */
function scriptKindOrJs(path: string): ts.ScriptKind {
  return path.endsWith('.ts') || path.endsWith('.tsx') ? scriptKindOf(path) : ts.ScriptKind.JS
}

function isFunctionValue(node: ts.Expression | undefined): boolean {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
}

interface Declaration {
  readonly name: string
  readonly kind: DeclarationKind
  /** A named, non-default export. */
  readonly exported: boolean
}

/** The names one top-level statement declares, whether or not it exports them. */
function declarationsOf(statement: ts.Statement): Declaration[] {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
  const keywords = new Set(modifiers?.map((m) => m.kind))
  const exported =
    keywords.has(ts.SyntaxKind.ExportKeyword) && !keywords.has(ts.SyntaxKind.DefaultKeyword)
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name)
        ? [
            {
              name: declaration.name.text,
              kind: isFunctionValue(declaration.initializer)
                ? ('function' as const)
                : ('const' as const),
              exported,
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
  return kind !== undefined && name !== undefined ? [{ name: name.text, kind, exported }] : []
}

/** Non-default, named export declarations of a source file, one per declared name. */
function exportsOf(path: string, source: ts.SourceFile): ExportDef[] {
  return source.statements.flatMap((statement) =>
    declarationsOf(statement)
      .filter(({ exported }) => exported)
      .map(({ name, kind }) => ({ name, path, kind })),
  )
}

/** A name one file takes from another module, under the name the exporter gave it. */
interface Binding {
  readonly name: string
  /** The module specifier, or undefined when it is not a string literal. */
  readonly spec: string | undefined
  /** `export { name } from spec`: publishing the name, which is not using it. */
  readonly reexport: boolean
}

const specText = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined

/** What a file's top-level statements say about what it imports, forwards and declares. */
interface StaticFacts {
  readonly bindings: Binding[]
  /** Local name of a `import * as ns` -> its module. */
  readonly namespaces: Map<string, string | undefined>
  /** Names the file binds locally, by import. */
  readonly importedLocals: Set<string>
  /** Names the file declares at its top level, exported or not. */
  readonly declared: Set<string>
  readonly exports: {
    readonly declared: Set<string>
    readonly forwarded: Map<string, { spec: string; imported: string }>
    readonly stars: string[]
  }
}

function addImport(statement: ts.ImportDeclaration, facts: StaticFacts): void {
  const clause = statement.importClause
  const spec = specText(statement.moduleSpecifier)
  if (clause?.name !== undefined) facts.importedLocals.add(clause.name.text)
  const bindings = clause?.namedBindings
  if (bindings === undefined) return
  if (ts.isNamespaceImport(bindings)) {
    facts.namespaces.set(bindings.name.text, spec)
    facts.importedLocals.add(bindings.name.text)
    return
  }
  for (const element of bindings.elements) {
    facts.importedLocals.add(element.name.text)
    facts.bindings.push({
      name: (element.propertyName ?? element.name).text,
      spec,
      reexport: false,
    })
  }
}

function addExport(
  statement: ts.ExportDeclaration,
  facts: StaticFacts,
  forwarded: Map<string, { spec: string; imported: string }>,
  stars: string[],
): void {
  const spec = specText(statement.moduleSpecifier)
  const clause = statement.exportClause
  if (spec === undefined) return
  if (clause === undefined) {
    stars.push(spec)
    return
  }
  if (!ts.isNamedExports(clause)) return
  for (const element of clause.elements) {
    const imported = (element.propertyName ?? element.name).text
    facts.bindings.push({ name: imported, spec, reexport: true })
    forwarded.set(element.name.text, { spec, imported })
  }
}

/** `export { a as b }` with no module: `b` is `a`'s declaration, or what `a` was imported as. */
function addLocalExportList(
  statement: ts.ExportDeclaration,
  importedAs: ReadonlyMap<string, { spec: string; imported: string }>,
  facts: StaticFacts,
  forwarded: Map<string, { spec: string; imported: string }>,
): void {
  const clause = statement.exportClause
  if (statement.moduleSpecifier !== undefined || clause === undefined) return
  if (!ts.isNamedExports(clause)) return
  for (const element of clause.elements) {
    const local = (element.propertyName ?? element.name).text
    const from = importedAs.get(local)
    if (from === undefined) facts.exports.declared.add(element.name.text)
    else forwarded.set(element.name.text, from)
  }
}

/** The local name -> where it was imported from, for the named imports of a file. */
function importedNamesOf(source: ts.SourceFile): Map<string, { spec: string; imported: string }> {
  const importedAs = new Map<string, { spec: string; imported: string }>()
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined
    const spec = ts.isImportDeclaration(statement) ? specText(statement.moduleSpecifier) : undefined
    if (bindings === undefined || spec === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      importedAs.set(element.name.text, {
        spec,
        imported: (element.propertyName ?? element.name).text,
      })
    }
  }
  return importedAs
}

function staticFacts(source: ts.SourceFile): StaticFacts {
  const declared = new Set<string>()
  const forwarded = new Map<string, { spec: string; imported: string }>()
  const stars: string[] = []
  const facts: StaticFacts = {
    bindings: [],
    namespaces: new Map(),
    importedLocals: new Set(),
    declared,
    exports: { declared: new Set(), forwarded, stars },
  }
  const importedAs = importedNamesOf(source)
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) addImport(statement, facts)
    else if (ts.isExportDeclaration(statement)) {
      addExport(statement, facts, forwarded, stars)
      addLocalExportList(statement, importedAs, facts, forwarded)
    }
    for (const declaration of declarationsOf(statement)) {
      declared.add(declaration.name)
      if (declaration.exported) facts.exports.declared.add(declaration.name)
    }
  }
  return facts
}

/** An `import(...)` call, or `vi.importActual(...)`, looked through `await` and parentheses. */
function dynamicImportCall(node: ts.Node): ts.CallExpression | undefined {
  let inner = node
  while (ts.isAwaitExpression(inner) || ts.isParenthesizedExpression(inner))
    inner = inner.expression
  if (!ts.isCallExpression(inner)) return undefined
  const callee = inner.expression
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return inner
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'importActual'
    ? inner
    : undefined
}

/** The module a dynamic import names, when written as a literal. */
const dynamicSpec = (call: ts.CallExpression): string | undefined => specText(call.arguments[0])

/** `const mod = await import(...)` makes `mod` a namespace, whichever test body declares it. */
function addDynamicNamespaces(
  source: ts.SourceFile,
  namespaces: Map<string, string | undefined>,
): void {
  const visit = (node: ts.Node): void => {
    const call =
      ts.isVariableDeclaration(node) && node.initializer !== undefined
        ? dynamicImportCall(node.initializer)
        : undefined
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && call !== undefined) {
      namespaces.set(node.name.text, dynamicSpec(call))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

/** `ns.name` and `(await import(...)).name`. */
function memberOfImport(
  node: ts.Node,
  namespaces: ReadonlyMap<string, string | undefined>,
): Binding[] {
  if (!ts.isPropertyAccessExpression(node)) return []
  const owner = node.expression
  const call = dynamicImportCall(owner)
  const known = ts.isIdentifier(owner) && namespaces.has(owner.text)
  if (!known && call === undefined) return []
  const spec = known
    ? namespaces.get((owner as ts.Identifier).text)
    : dynamicSpec(call as ts.CallExpression)
  return [{ name: node.name.text, spec, reexport: false }]
}

/** `const { a, b: c } = await import(...)` binds `a` and `b`. */
function destructuredFromImport(node: ts.Node): Binding[] {
  if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name)) return []
  const call = node.initializer === undefined ? undefined : dynamicImportCall(node.initializer)
  if (call === undefined) return []
  return node.name.elements.flatMap((element) => {
    const imported = element.propertyName ?? element.name
    return ts.isIdentifier(imported)
      ? [{ name: imported.text, spec: dynamicSpec(call), reexport: false }]
      : []
  })
}

/** `typeof import('./x').T`'s `T`. */
function qualifiedImportType(node: ts.Node): Binding[] {
  if (!ts.isImportTypeNode(node) || node.qualifier === undefined) return []
  const { qualifier } = node
  const spec = ts.isLiteralTypeNode(node.argument) ? specText(node.argument.literal) : undefined
  return [
    {
      name: ts.isIdentifier(qualifier) ? qualifier.text : qualifier.right.text,
      spec,
      reexport: false,
    },
  ]
}

/**
 * What a test file binds from another module: a named import (under the name
 * the exporter gave it), a `from` re-export, a member of a namespace import,
 * and the destructured or dotted result of a dynamic `import()`, each with the
 * module it names.
 *
 * A name that only appears in the text — a title, a comment, a string, the
 * ledger spelling `path#name` — binds nothing, and reading it as a use is how
 * a name no test imports stayed on the books. Methods called on an instance
 * the test built are not imports either, which is why a class is judged by the
 * import of the class itself.
 */
function testBindings(text: string, facts: StaticFacts, source: ts.SourceFile): Binding[] {
  const found = [...facts.bindings]
  // Only a file that can reach a member some other way pays for a full walk.
  const dynamic = text.includes('import(') || text.includes('importActual')
  if (facts.namespaces.size === 0 && !dynamic) return found
  if (dynamic) addDynamicNamespaces(source, facts.namespaces)
  const visit = (node: ts.Node): void => {
    found.push(
      ...memberOfImport(node, facts.namespaces),
      ...destructuredFromImport(node),
      ...qualifiedImportType(node),
    )
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

interface ProductionWords {
  /** Identifier occurrences, by name, for the uses inside a declaring file. */
  readonly counts: Map<string, number>
  /**
   * Names used with nothing in the file to say what they are: no import binds
   * them and no top-level declaration owns them. A property read off an
   * instance, a dynamic import's destructure and a nested local all land here,
   * and are counted as a use of any export spelled that way.
   */
  readonly loose: Set<string>
  /** `ns.name` through a static namespace import. */
  readonly members: Binding[]
}

/**
 * Identifier occurrences in one shipped file. An `import` declaration is
 * skipped (`staticFacts` already holds what it binds) and so is an
 * `export { x } from` re-export: a barrel naming a symbol is not a use of it,
 * and counting one would make every barrel export look consumed. A local
 * `export { x }` is a use of `x`, like any other mention.
 */
/** An identifier that names a member (`x.name`, `{ name: v }`, a method or field) and so is not a reference to a local binding. */
function isMemberName(node: ts.Identifier, parent: ts.Node | undefined): boolean {
  if (parent === undefined) return false
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node
  if (ts.isQualifiedName(parent)) return parent.right === node
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent)) &&
    parent.name === node
  )
}

function ownerAndMember(node: ts.Node): readonly [ts.Node?, ts.MemberName?] {
  if (ts.isPropertyAccessExpression(node)) return [node.expression, node.name]
  if (ts.isQualifiedName(node)) return [node.left, node.right]
  return []
}

/** `ns.name` as an expression or a type, when `ns` is a static namespace import. */
function namespaceMember(
  node: ts.Node,
  namespaces: ReadonlyMap<string, string | undefined>,
): Binding | undefined {
  const [owner, member] = ownerAndMember(node)
  if (owner === undefined || member === undefined || !ts.isIdentifier(owner)) return undefined
  return namespaces.has(owner.text)
    ? { name: member.text, spec: namespaces.get(owner.text), reexport: false }
    : undefined
}

function productionWords(source: ts.SourceFile, facts: StaticFacts): ProductionWords {
  const counts = new Map<string, number>()
  const loose = new Set<string>()
  const members: Binding[] = []
  const bound = (name: string): boolean =>
    facts.importedLocals.has(name) || facts.declared.has(name)
  const count = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const visit = (node: ts.Node, parent: ts.Node | undefined): void => {
    if (ts.isImportDeclaration(node)) return
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) return
    const member = namespaceMember(node, facts.namespaces)
    if (member !== undefined) {
      count(member.name)
      members.push(member)
      return
    }
    if (ts.isIdentifier(node)) {
      count(node.text)
      if (isMemberName(node, parent) || !bound(node.text)) loose.add(node.text)
    }
    ts.forEachChild(node, (child) => visit(child, node))
  }
  visit(source, undefined)
  return { counts, loose, members }
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

/** One file's use of a name, with the module it came from. */
interface UseSite {
  readonly file: string
  readonly spec: string | undefined
}

interface ReadFiles {
  readonly modules: Map<string, ModuleExports>
  /** Shipped files' imports and namespace members, by the name imported. */
  readonly production: Map<string, UseSite[]>
  /** Shipped files' `export { x } from` re-exports, by the name forwarded. */
  readonly reexported: Map<string, UseSite[]>
  /** Names a shipped file uses with no import or declaration saying what they are. */
  readonly loose: Map<string, Set<string>>
  readonly testBound: Map<string, UseSite[]>
  readonly defs: (ExportDef & { counts: Map<string, number> })[]
}

function addTo<V>(map: Map<string, V[]>, key: string, value: V): void {
  const held = map.get(key) ?? []
  held.push(value)
  map.set(key, held)
}

function readShipped(
  path: string,
  source: ts.SourceFile,
  facts: StaticFacts,
  read: ReadFiles,
): void {
  const words = productionWords(source, facts)
  for (const binding of [...facts.bindings, ...words.members]) {
    addTo(binding.reexport ? read.reexported : read.production, binding.name, {
      file: path,
      spec: binding.spec,
    })
  }
  for (const name of words.loose) {
    const files = read.loose.get(name) ?? new Set<string>()
    files.add(path)
    read.loose.set(name, files)
  }
  if (!/(^|\/)src\//.test(path) || isExemptDefiner(path)) return
  for (const def of exportsOf(path, source)) read.defs.push({ ...def, counts: words.counts })
}

function readFiles(files: readonly ScannedFile[]): ReadFiles {
  const read: ReadFiles = {
    modules: new Map(),
    production: new Map(),
    reexported: new Map(),
    loose: new Map(),
    testBound: new Map(),
    defs: [],
  }
  for (const { path, text } of files) {
    // No parent pointers: nothing here walks upward, and they are most of the cost of a parse.
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      false,
      scriptKindOrJs(path),
    )
    const facts = staticFacts(source)
    read.modules.set(path, facts.exports)
    if (!isTestFile(path)) {
      readShipped(path, source, facts, read)
      continue
    }
    for (const binding of testBindings(text, facts, source)) {
      addTo(read.testBound, binding.name, { file: path, spec: binding.spec })
    }
  }
  return read
}

/**
 * Exports of shipped source under `*\/src/` that no other shipped file uses and
 * some test imports.
 *
 * Knip counts a test's import as a use, so a symbol kept alive only by its own
 * test is invisible to it. A use is bound to a declaration by the module it was
 * imported from and the name it was imported under, followed through barrels
 * (`createExportResolver`), so two exports sharing a name are judged apart.
 * `entries` names where each workspace package specifier lands.
 *
 * Where a binding cannot be resolved the NAME decides, and the method errs
 * toward false negatives on purpose: an unresolved import, a property read off
 * an instance, or a dynamic import's destructure in any other shipped file
 * counts as use of any export spelled that way, so a flagged name is one nothing
 * else shipped even spells. A test uses a name only by binding it
 * (`testBindings`), so a name a test merely mentions is not counted. `ownUses`
 * separates "no use at all, even in its own file" from "exported so its test
 * can reach an internal", and `class` says which kind of problem the remaining
 * ones are.
 */
export function findTestOnlyExports(
  files: readonly ScannedFile[],
  entries: ReadonlyMap<string, string> = new Map(),
): TestOnlyExport[] {
  const read = readFiles(files)
  const resolve = createExportResolver(read.modules, entries)
  const bindsTo = (def: ExportDef, site: UseSite): boolean => {
    const resolved = resolve(site.file, site.spec, def.name)
    return resolved === 'unknown' || (typeof resolved === 'object' && resolved.path === def.path)
  }
  const sitesFor = (map: Map<string, UseSite[]>, def: ExportDef): UseSite[] =>
    (map.get(def.name) ?? []).filter((site) => site.file !== def.path && bindsTo(def, site))
  const usedElsewhere = (def: ExportDef): boolean =>
    [...(read.loose.get(def.name) ?? [])].some((file) => file !== def.path) ||
    sitesFor(read.production, def).length > 0
  const classify = (
    def: ExportDef,
    ownUses: number,
    importers: ReadonlySet<string>,
  ): TestOnlyClass => {
    if (ownUses === 0) return 'dead'
    if (sitesFor(read.reexported, def).length > 0) return 'barrel-only'
    const siblingImports = [...importers].some((test) => isSiblingTest(def.path, test))
    return siblingImports && isShapeDeclaration(def) ? 'shape' : 'reached'
  }
  return read.defs
    .filter(({ name }) => !/(ForTests|_FOR_TESTS)$/.test(name) && !name.startsWith('_'))
    .flatMap(({ counts, ...def }) => {
      if (usedElsewhere(def)) return []
      const importers = new Set(sitesFor(read.testBound, def).map(({ file }) => file))
      if (importers.size === 0) return []
      const ownUses = (counts.get(def.name) ?? 1) - 1
      return [
        {
          ...def,
          ownUses,
          key: `${def.path}#${def.name}`,
          class: classify(def, ownUses, importers),
        },
      ]
    })
}
