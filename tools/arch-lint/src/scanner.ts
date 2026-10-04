import { builtinModules } from 'node:module'
import ts from '@typescript/typescript6'

export type BoundaryViolationKind =
  | 'node-builtin-import'
  | 'inversify-import'
  | 'loro-crdt-import'
  | 'dom-global'
  | 'node-ambient-global'
  | 'test-framework-import'

export interface BoundaryViolation {
  readonly kind: BoundaryViolationKind
  readonly name: string
  readonly line: number
}

const NODE_BUILTIN_NAMES = new Set(builtinModules)

// A deny-list, not a model of the DOM lib: a name outside it passes. It holds
// names with no everyday meaning as a local or a property key, because this
// scan matches identifiers without scope analysis. `location` and `Image` are
// left out for that reason — `daemon-client`'s `WindowLike` declares a
// `location` property — so a read of either in a shared package is a named
// blind spot (see `.claude/rules/tool-arch-lint.md`), not a pass.
const DOM_GLOBAL_IDENTIFIERS = new Set([
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'HTMLElement',
  'HTMLCanvasElement',
  'HTMLImageElement',
  'OffscreenCanvas',
  'customElements',
  'requestAnimationFrame',
  'cancelAnimationFrame',
])

const NODE_AMBIENT_GLOBAL_IDENTIFIERS = new Set([
  'process',
  'Buffer',
  '__dirname',
  '__filename',
  'global',
])

// What `/// <reference types="node" />` names: Node's ambient types, which a
// shared package must not pull in any more than it may import `node:fs`.
const NODE_TYPES_PACKAGES = new Set(['node', '@types/node'])

function isNodeBuiltinSpecifier(specifier: string): boolean {
  if (NODE_TYPES_PACKAGES.has(specifier)) return true
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  const rootPackage = bare.split('/')[0]
  return NODE_BUILTIN_NAMES.has(rootPackage) || specifier.startsWith('node:')
}

function isInversifySpecifier(specifier: string): boolean {
  return (
    specifier === 'inversify' ||
    specifier.startsWith('inversify/') ||
    specifier.startsWith('@inversifyjs/')
  )
}

/**
 * A test framework in a file that ships. Vitest, fast-check and Testing
 * Library are devDependencies, so a production import of any resolves in the workspace
 * and fails only in a consumer's install — or drags the framework into a
 * bundle. Benches and a `testing/` entry import them on purpose; those are
 * ledgered per file in `architecture-map.ts`.
 */
function isTestFrameworkSpecifier(specifier: string): boolean {
  return (
    specifier === 'vitest' ||
    specifier.startsWith('vitest/') ||
    specifier.startsWith('@vitest/') ||
    specifier === 'fast-check' ||
    specifier.startsWith('@fast-check/') ||
    specifier.startsWith('@testing-library/')
  )
}

export interface ModuleSpecifierReference {
  readonly specifier: string
  // Whole edge is erased at emit and carries no runtime value: a whole-
  // declaration `import type`/`export type`, or a named-import/export list
  // whose specifiers are ALL inline-`type`. Syntactic, not semantic — an
  // un-annotated named import of an interface still reads as a value edge
  // (see cycle-check.ts, which is the consumer that cares about this field).
  readonly typeOnly: boolean
  readonly line: number
}

/** A string, or a template with no substitution — both name a module statically. */
function staticStringText(node: ts.Node | undefined): string | undefined {
  if (node === undefined) return undefined
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined
}

function isImportClauseTypeOnly(clause: ts.ImportClause): boolean {
  if (clause.isTypeOnly) return true
  // A default import (`import Foo, { type X } from`) is always a value,
  // regardless of the named bindings beside it.
  if (clause.name !== undefined) return false
  const bindings = clause.namedBindings
  if (bindings === undefined) return false
  // `import * as ns from` is a value edge.
  if (ts.isNamespaceImport(bindings)) return false
  return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly)
}

function isExportDeclarationTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true
  const clause = node.exportClause
  if (clause === undefined || ts.isNamespaceExport(clause)) return false
  return clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly)
}

/**
 * The module a `require(...)` or a dynamic `import(...)` names. Both always
 * evaluate their target, so each is a value edge by construction — there is no
 * `import type(...)`.
 */
function callSpecifier(node: ts.CallExpression): string | undefined {
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
  return isDynamicImport || isRequire ? staticStringText(node.arguments[0]) : undefined
}

/**
 * The module an `import('x')` TYPE names (`typeof import('x')`, `import('x').T`).
 * Erased at emit like `import type`, so always type-only, but it binds the two
 * modules exactly as an `import type` does and reaches the same boundaries.
 */
function importTypeSpecifier(node: ts.ImportTypeNode): string | undefined {
  return ts.isLiteralTypeNode(node.argument) ? staticStringText(node.argument.literal) : undefined
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

const isImportMetaUrl = (node: ts.Expression | undefined): boolean =>
  node !== undefined &&
  ts.isPropertyAccessExpression(node) &&
  node.name.text === 'url' &&
  ts.isMetaProperty(node.expression) &&
  node.expression.keywordToken === ts.SyntaxKind.ImportKeyword

/**
 * The file `new URL('./x.ts', import.meta.url)` names, as the relative
 * specifier an import of it would carry. That is how a bundler is told to build
 * a worker's module graph (`new Worker(new URL(...))`), so it binds the two
 * files exactly as an import does and reaches the same layer boundaries — an
 * edge no `import` statement spells. Only a URL resolved against
 * `import.meta.url` counts: any other base names no file this tree owns.
 */
function importMetaUrlSpecifier(node: ts.NewExpression): string | undefined {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'URL') return undefined
  const [target, base] = node.arguments ?? []
  const text = staticStringText(target)
  if (
    text === undefined ||
    !isImportMetaUrl(base) ||
    URL_SCHEME.test(text) ||
    text.startsWith('/')
  ) {
    return undefined
  }
  return text.startsWith('./') || text.startsWith('../') ? text : `./${text}`
}

/** The module an expression that runs at load time names, which is a value edge by construction. */
function evaluatedSpecifier(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node)) return callSpecifier(node)
  return ts.isNewExpression(node) ? importMetaUrlSpecifier(node) : undefined
}

interface NodeSpecifier {
  readonly specifier: string
  readonly typeOnly: boolean
}

/** The specifier one node contributes, if it is a form that names a module. */
function specifierOfNode(node: ts.Node): NodeSpecifier | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    const typeOnly = node.importClause !== undefined && isImportClauseTypeOnly(node.importClause)
    return { specifier: node.moduleSpecifier.text, typeOnly }
  }
  if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return { specifier: node.moduleSpecifier.text, typeOnly: isExportDeclarationTypeOnly(node) }
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteral(node.moduleReference.expression)
  ) {
    return { specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly }
  }
  const evaluated = evaluatedSpecifier(node)
  if (evaluated !== undefined) return { specifier: evaluated, typeOnly: false }
  if (ts.isImportTypeNode(node)) {
    const specifier = importTypeSpecifier(node)
    if (specifier !== undefined) return { specifier, typeOnly: true }
  }
  return undefined
}

/**
 * `/// <reference path|types>` directives, which pull a file or a types package
 * into the program with no import statement. `path` is resolved against the
 * referencing file whether or not it starts with `./`, so it is normalised to
 * the relative form every consumer of a specifier expects. `lib` names no
 * module and is not read.
 */
function referenceDirectiveSpecifiers(sourceFile: ts.SourceFile): ModuleSpecifierReference[] {
  const at = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1
  const paths = sourceFile.referencedFiles.map(({ fileName, pos }) => ({
    specifier: fileName.startsWith('.') ? fileName : `./${fileName}`,
    typeOnly: true,
    line: at(pos),
  }))
  const types = sourceFile.typeReferenceDirectives.map(({ fileName, pos }) => ({
    specifier: fileName,
    typeOnly: true,
    line: at(pos),
  }))
  return [...paths, ...types]
}

/**
 * Every place a module specifier can appear in source text: a static
 * `import`/`export ... from`, a dynamic `import(...)` call, a `require(...)`
 * call, an `import x = require(...)`, an `import('x')` type, or a
 * `/// <reference path|types>` directive. Missing any one of these would let a
 * banned import back in through a form the AST walk never visits. A specifier
 * written as a template literal with no substitution is read like a string;
 * one WITH a substitution names no module statically and is a named blind
 * spot (`.claude/rules/tool-arch-lint.md`).
 */
export function collectModuleSpecifiers(sourceFile: ts.SourceFile): ModuleSpecifierReference[] {
  const specifiers: ModuleSpecifierReference[] = referenceDirectiveSpecifiers(sourceFile)

  function visit(node: ts.Node): void {
    const found = specifierOfNode(node)
    if (found !== undefined) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      specifiers.push({ ...found, line: line + 1 })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

/**
 * Whether an identifier node is a NAME being declared or a property key rather
 * than a read of the ambient global it spells. A property access like
 * `foo.window` (banned name as the *property*, i.e. the right side of the
 * access) or a declared local named `process` is not a use of the ambient
 * global — only a bare identifier reference counts. `window.location.href` and
 * `process.env.FOO` must still be flagged: there `window`/`process` is the
 * *object* side (`.expression`), not the `.name`, of the PropertyAccessExpression.
 */
function isNameNotARead(node: ts.Identifier): boolean {
  const parent = node.parent
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ((ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent)) &&
      parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    // `declare global { … }` — the TypeScript ambient-augmentation
    // keyword, a type-level construct — is not a read of Node's `global`
    // object. The identifier is the ModuleDeclaration's NAME there.
    (ts.isModuleDeclaration(parent) && parent.name === node)
  )
}

/**
 * The banned global a node reads, if it reads one: a bare identifier, or
 * `globalThis.<name>`, which reaches the same global and has no bare
 * identifier to match.
 */
function bannedGlobalRead(node: ts.Node, bannedNames: ReadonlySet<string>): string | undefined {
  if (ts.isIdentifier(node) && bannedNames.has(node.text) && !isNameNotARead(node)) {
    return node.text
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'globalThis' &&
    bannedNames.has(node.name.text)
  ) {
    return node.name.text
  }
  return undefined
}

function collectBannedGlobalIdentifierUsages(
  sourceFile: ts.SourceFile,
  bannedNames: Set<string>,
  kind: BoundaryViolationKind,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = []

  function visit(node: ts.Node): void {
    const name = bannedGlobalRead(node, bannedNames)
    if (name !== undefined) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      violations.push({ kind, name, line: line + 1 })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

export function scanSourceForBoundaryViolations(
  fileName: string,
  sourceText: string,
): BoundaryViolation[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true)
  const violations: BoundaryViolation[] = []

  for (const { specifier, line } of collectModuleSpecifiers(sourceFile)) {
    if (isNodeBuiltinSpecifier(specifier)) {
      violations.push({ kind: 'node-builtin-import', name: specifier, line })
    }
    if (isInversifySpecifier(specifier)) {
      violations.push({ kind: 'inversify-import', name: specifier, line })
    }
    if (isTestFrameworkSpecifier(specifier)) {
      violations.push({ kind: 'test-framework-import', name: specifier, line })
    }
    if (specifier === 'loro-crdt' || specifier.startsWith('loro-crdt/')) {
      violations.push({ kind: 'loro-crdt-import', name: specifier, line })
    }
  }

  violations.push(
    ...collectBannedGlobalIdentifierUsages(sourceFile, DOM_GLOBAL_IDENTIFIERS, 'dom-global'),
  )
  violations.push(
    ...collectBannedGlobalIdentifierUsages(
      sourceFile,
      NODE_AMBIENT_GLOBAL_IDENTIFIERS,
      'node-ambient-global',
    ),
  )

  return violations
}
