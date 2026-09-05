import { builtinModules } from 'node:module'
import ts from 'typescript'

export type BoundaryViolationKind =
  | 'node-builtin-import'
  | 'inversify-import'
  | 'loro-crdt-import'
  | 'dom-global'
  | 'node-ambient-global'

export interface BoundaryViolation {
  readonly kind: BoundaryViolationKind
  readonly name: string
  readonly line: number
}

const NODE_BUILTIN_NAMES = new Set(builtinModules)

const DOM_GLOBAL_IDENTIFIERS = new Set([
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'HTMLElement',
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

function isNodeBuiltinSpecifier(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier
  const rootPackage = bare.split('/')[0]
  return NODE_BUILTIN_NAMES.has(rootPackage) || specifier.startsWith('node:')
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

/**
 * Every place a module specifier can appear in source text: a static
 * `import`/`export ... from`, or a dynamic `import(...)` call. Missing any
 * one of these would let a banned import back in through a form the AST
 * walk never visits.
 */
export function collectModuleSpecifiers(sourceFile: ts.SourceFile): ModuleSpecifierReference[] {
  const specifiers: ModuleSpecifierReference[] = []

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

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      const typeOnly = node.importClause !== undefined && isImportClauseTypeOnly(node.importClause)
      specifiers.push({ specifier: node.moduleSpecifier.text, typeOnly, line: line + 1 })
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      specifiers.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: isExportDeclarationTypeOnly(node),
        line: line + 1,
      })
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      // A dynamic `import()` call always evaluates the target module, so it
      // is a value edge by construction — there is no `import type(...)`.
      specifiers.push({ specifier: node.arguments[0].text, typeOnly: false, line: line + 1 })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

function collectBannedGlobalIdentifierUsages(
  sourceFile: ts.SourceFile,
  bannedNames: Set<string>,
  kind: BoundaryViolationKind,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = []

  function visit(node: ts.Node): void {
    // A property access like `foo.window` (banned name as the *property*,
    // i.e. the right side of the access) or a declared local named
    // `process` is not a use of the ambient global — only a bare identifier
    // reference (not the name being declared, and not the property side of
    // a member access) counts. `window.location.href` and `process.env.FOO`
    // must still be flagged: there `window`/`process` is the *object* side
    // (`.expression`), not the `.name`, of the PropertyAccessExpression.
    if (
      ts.isIdentifier(node) &&
      bannedNames.has(node.text) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(
        (ts.isVariableDeclaration(node.parent) ||
          ts.isFunctionDeclaration(node.parent) ||
          ts.isParameter(node.parent) ||
          ts.isBindingElement(node.parent)) &&
        node.parent.name === node
      ) &&
      !(ts.isImportSpecifier(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
      // `declare global { … }` — the TypeScript ambient-augmentation
      // keyword, a type-level construct — is not a read of Node's `global`
      // object. The identifier is the ModuleDeclaration's NAME there.
      !(ts.isModuleDeclaration(node.parent) && node.parent.name === node)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      violations.push({ kind, name: node.text, line: line + 1 })
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
    if (specifier === 'inversify') {
      violations.push({ kind: 'inversify-import', name: specifier, line })
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
