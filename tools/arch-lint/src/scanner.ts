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

/**
 * Every place a module specifier can appear in source text: a static
 * `import`/`export ... from`, or a dynamic `import(...)` call. Missing any
 * one of these would let a banned import back in through a form the AST
 * walk never visits.
 */
function collectModuleSpecifiers(sourceFile: ts.SourceFile): { specifier: string; line: number }[] {
  const specifiers: { specifier: string; line: number }[] = []

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      specifiers.push({ specifier: node.moduleSpecifier.text, line: line + 1 })
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      specifiers.push({ specifier: node.arguments[0].text, line: line + 1 })
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
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
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
