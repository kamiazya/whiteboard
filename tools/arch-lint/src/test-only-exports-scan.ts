import ts from '@typescript/typescript6'

/** A source file as the scan reads it. `path` is repo-relative and `/`-separated. */
export interface ScannedFile {
  readonly path: string
  readonly text: string
}

interface ExportDef {
  readonly name: string
  readonly path: string
}

export interface TestOnlyExport extends ExportDef {
  /** Uses of the name inside its own file, the declaration excluded. */
  readonly ownUses: number
  /** `<path>#<name>`, as the ledger spells it. */
  readonly key: string
}

/**
 * A test, or a file only tests import: the vocabulary of a path that means
 * "this is not shipped". Smoke and distribution harnesses count, since they run
 * a built artefact and are never part of one.
 */
export function isTestFile(path: string): boolean {
  return (
    /\.(test|spec)\.[a-z]+$/.test(path) ||
    /(^|\/)(test-utils|testing|__tests__|fixtures|e2e|docs-snapshots)(\/|$)/.test(path) ||
    /-test-utils\.[a-z]+$/.test(path) ||
    /\.(smoke-impl|distribution-impl|stress)\./.test(path)
  )
}

/**
 * The ledger that lists these names. It is a test file by its path and spells
 * every listed key, so reading its words would count each one as a test using it.
 */
const LEDGER_FILE = 'tools/arch-lint/src/test-only-exports.test.ts'

/** A file whose exports are test scaffolding by name, or a tool that polices the repo. */
function isExemptDefiner(path: string): boolean {
  return (
    path.startsWith('tools/arch-lint/') ||
    path.startsWith('tools/checks/') ||
    /(^|\/)_test-[^/]*$/.test(path) ||
    /(^|[./-])test-helpers?\.[a-z]+$/.test(path)
  )
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.ts')) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

/** The names one top-level statement declares, when it is a named, non-default export. */
function exportedNames(statement: ts.Statement): string[] {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
  const keywords = new Set(modifiers?.map((m) => m.kind))
  if (!keywords.has(ts.SyntaxKind.ExportKeyword) || keywords.has(ts.SyntaxKind.DefaultKeyword)) {
    return []
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    )
  }
  const named =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement)
  return named && statement.name !== undefined ? [statement.name.text] : []
}

/** Non-default, named export declarations of a source file, one per declared name. */
function exportsOf(path: string, source: ts.SourceFile): ExportDef[] {
  return source.statements.flatMap((statement) =>
    exportedNames(statement).map((name) => ({ name, path })),
  )
}

/**
 * Identifier occurrences in one file, by name.
 *
 * `export { x } from './y'` re-exports are skipped: a barrel naming a symbol
 * is not a use of it, and counting one would make every barrel export look
 * consumed. A local `export { x }` is a use of `x`, like any other mention.
 */
function identifierCounts(source: ts.SourceFile): Map<string, number> {
  const counts = new Map<string, number>()
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) return
    if (ts.isIdentifier(node)) counts.set(node.text, (counts.get(node.text) ?? 0) + 1)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return counts
}

/**
 * Exports of shipped source under `*\/src/` that no other shipped file uses and
 * some test does.
 *
 * Knip counts a test's import as a use, so a symbol kept alive only by its own
 * test is invisible to it. The method errs toward false negatives on purpose:
 * a same-named identifier in ANY other shipped file counts as production use,
 * so a flagged name is one nothing else shipped even spells. `ownUses`
 * separates "no use at all, even in its own file" from "exported so its test
 * can reach an internal".
 */
export function findTestOnlyExports(files: readonly ScannedFile[]): TestOnlyExport[] {
  const production = new Map<string, Set<string>>()
  const testWords = new Set<string>()
  const defs: (ExportDef & { counts: Map<string, number> })[] = []
  for (const { path, text } of files) {
    if (isTestFile(path)) {
      if (path === LEDGER_FILE) continue
      // A test is only asked whether it names a symbol, so its words are read
      // without a parse: a comment mentioning one is a name worth a second look
      // rather than a miss, and tests are most of the tree.
      for (const word of text.match(/[A-Za-z_$][\w$]*/g) ?? []) testWords.add(word)
      continue
    }
    // No parent pointers: nothing here walks upward, and they are most of the cost of a parse.
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path))
    const counts = identifierCounts(source)
    for (const name of counts.keys()) {
      const holders = production.get(name) ?? new Set<string>()
      holders.add(path)
      production.set(name, holders)
    }
    if (!/(^|\/)src\//.test(path) || isExemptDefiner(path)) continue
    for (const def of exportsOf(path, source)) defs.push({ ...def, counts })
  }
  return defs
    .filter(({ name }) => !/(ForTests|_FOR_TESTS)$/.test(name) && !name.startsWith('_'))
    .filter(({ name, path }) => {
      const holders = production.get(name)
      const usedElsewhere = holders !== undefined && [...holders].some((holder) => holder !== path)
      return !usedElsewhere && testWords.has(name)
    })
    .map(({ counts, ...def }) => ({
      ...def,
      ownUses: (counts.get(def.name) ?? 1) - 1,
      key: `${def.path}#${def.name}`,
    }))
}
