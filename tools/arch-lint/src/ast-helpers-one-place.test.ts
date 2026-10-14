/**
 * This tool's guards read source through `ast-helpers.ts`, and nothing else
 * writes out the two steps every one of them takes: choose the parser mode from
 * the extension, and look through the wrappers that change an expression's type
 * and not its value.
 *
 * Parsing is the third: a file handed straight to `ts.createSourceFile` takes
 * the parser mode from the extension alone and drifts from the guards that
 * ask `parseSource`, whose mode and parent-pointer choice are written once.
 *
 * Resolving an import is the fourth: which local name binds an export of a
 * module, through a rename, a namespace or a default import. It was written
 * out in thirteen guards, each accepting a different subset of those
 * spellings, so whether a guard saw `timers.setTimeout(100)` or a subclass of
 * the store it fences depended on which file it was copied from. Any read of
 * an import clause's parts (`importClause`, `namedBindings`, the
 * `NamedImports` / `NamespaceImport` / `ImportClause` / `ImportSpecifier`
 * predicates and kinds) is that walk; asking whether an identifier's PARENT
 * is an import specifier is a question about a name slot, and is left alone.
 * Export specifiers are not import bindings and are not read.
 *
 * Both were spelled at half a dozen guards each, and the copies had already
 * diverged — one skipped `as` and `satisfies`, so `(save as Fn)(doc)` was not
 * the call it is. A guard that cannot see a call reports clean, which reads
 * exactly like one that looked.
 *
 * Read from the syntax tree, anywhere but `ast-helpers.ts`: a function by one
 * of the helpers' names, a `ScriptKind.TSX` chosen by a ternary, a loop that
 * peels `as` / `satisfies` / `!` / `<T>x` itself, and any look through
 * parentheses (`isParenthesizedExpression` has no other job), and a call of
 * `createSourceFile` on anything. A walk UP from a
 * node uses `isTypeOnlyWrapper`; a guard that really means `as` alone (an
 * `as const` read, an errno typing) tests it outside a loop and is not flagged.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource } from './ast-helpers.js'

const OWNER = 'ast-helpers.ts'
const HELPER_NAME = /^(unwrap(Expression)?|scriptKind(Of)?)$/
const WRAPPER_PREDICATE = /^is(Parenthesized|As|Satisfies|NonNull|TypeAssertion)Expression$/
const isPredicateRead = (node: ts.Node): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) && WRAPPER_PREDICATE.test(node.name.text)
const mentionsWrapperPredicate = (node: ts.Node): boolean => {
  let mentioned = false
  const look = (inner: ts.Node): void => {
    if (isPredicateRead(inner)) mentioned = true
    else ts.forEachChild(inner, look)
  }
  look(node)
  return mentioned
}

const IMPORT_PART = /^(importClause|namedBindings)$/
const IMPORT_PREDICATE = /^is(NamedImports|NamespaceImport|ImportClause|ImportSpecifier)$/
const IMPORT_KIND = /^(NamedImports|NamespaceImport|ImportClause|ImportSpecifier)$/

/** `x.parent` or a bare `parent`: what an identifier sits in, not a walk down an import. */
const isParentRead = (node: ts.Expression | undefined): boolean =>
  node !== undefined &&
  ((ts.isIdentifier(node) && node.text === 'parent') ||
    (ts.isPropertyAccessExpression(node) && node.name.text === 'parent'))

/** What reads an import declaration's parts by hand, or undefined. */
function importWalk(node: ts.Node): string | undefined {
  if (!ts.isPropertyAccessExpression(node)) return undefined
  const name = node.name.text
  if (IMPORT_PART.test(name)) return 'walks an import by hand'
  if (IMPORT_KIND.test(name) && node.expression.getText().endsWith('SyntaxKind')) {
    return 'walks an import by hand'
  }
  const call = node.parent
  const asked = IMPORT_PREDICATE.test(name) && ts.isCallExpression(call) && call.expression === node
  if (!asked) return undefined
  return name === 'isImportSpecifier' && isParentRead(call.arguments[0])
    ? undefined
    : 'walks an import by hand'
}

function loopCondition(node: ts.Node): ts.Node | undefined {
  if (ts.isWhileStatement(node) || ts.isDoStatement(node)) return node.expression
  return ts.isForStatement(node) ? node.condition : undefined
}

function respellings(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const named =
      (ts.isFunctionDeclaration(node) && node.name) ||
      (ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
        node.name)
    if (named && ts.isIdentifier(named) && HELPER_NAME.test(named.text)) {
      found.push(`defines ${named.text}`)
    }
    if (ts.isConditionalExpression(node) && node.whenTrue.getText(file) === 'ts.ScriptKind.TSX') {
      found.push('chooses the parser mode by hand')
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'createSourceFile'
    ) {
      found.push('parses by hand')
    }
    if (isPredicateRead(node) && node.name.text === 'isParenthesizedExpression') {
      found.push('looks through parentheses by hand')
    }
    const walk = importWalk(node)
    if (walk !== undefined) found.push(walk)
    const condition = loopCondition(node)
    if (condition !== undefined && mentionsWrapperPredicate(condition)) {
      found.push('loops over the wrappers by hand')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const dir = import.meta.dirname
const files = readdirSync(dir).filter((name) => name.endsWith('.ts'))

describe('the AST helpers are written once in tools/arch-lint', () => {
  it('scans the guards, so a clean result is not an empty walk', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(OWNER)
  })

  it('no guard but the owner defines them', () => {
    const respelled = files
      .filter((name) => name !== OWNER)
      .flatMap((name) =>
        respellings(name, readFileSync(join(dir, name), 'utf8')).map((what) => `${name} ${what}`),
      )
    expect(
      respelled,
      `use ${OWNER}: scriptKindOf / unwrapExpression / parseSource / importedBindings / importBindingsOf`,
    ).toEqual([])
  })

  describe('the scan itself, on planted source', () => {
    it('sees a declaration, an arrow and a ternary', () => {
      expect(respellings('p.ts', 'function unwrap(n: N) { return n }')).toEqual(['defines unwrap'])
      expect(respellings('p.ts', 'const scriptKind = (f: string) => 1')).toEqual([
        'defines scriptKind',
      ])
      expect(
        respellings('p.ts', "const k = f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS"),
      ).toEqual(['chooses the parser mode by hand'])
    })

    it('sees a direct parse, however it is called', () => {
      expect(
        respellings('p.ts', 'const f = ts.createSourceFile(n, t, ts.ScriptTarget.Latest, true)'),
      ).toEqual(['parses by hand'])
      expect(
        respellings('p.ts', 'const f = typescript.createSourceFile(n, t, 99, false, kind)'),
      ).toEqual(['parses by hand'])
    })

    it('sees a hand-rolled peel of the wrappers, in a loop and as a parenthesis test', () => {
      for (const predicate of ['As', 'Satisfies', 'NonNull', 'TypeAssertion']) {
        expect(
          respellings('p.ts', `while (ts.is${predicate}Expression(n)) n = n.expression`),
          predicate,
        ).toEqual(['loops over the wrappers by hand'])
      }
      expect(
        respellings('p.ts', 'for (let c = n; ts.isSatisfiesExpression(c); c = c.expression) {}'),
      ).toEqual(['loops over the wrappers by hand'])
      expect(
        respellings('p.ts', 'do { n = n.expression } while (ts.isTypeAssertionExpression(n))'),
      ).toEqual(['loops over the wrappers by hand'])
      expect(
        respellings(
          'p.ts',
          'while (ts.isAwaitExpression(i) || ts.isParenthesizedExpression(i)) i = i.expression',
        ),
      ).toEqual(['loops over the wrappers by hand', 'looks through parentheses by hand'])
      expect(
        respellings('p.ts', 'if (ts.isParenthesizedExpression(n)) return f(n.expression)'),
      ).toEqual(['looks through parentheses by hand'])
    })

    it('leaves a single-wrapper test outside a loop, and a loop over something else, alone', () => {
      expect(
        respellings('p.ts', 'const typed = ts.isAsExpression(n) ? n.type : undefined'),
      ).toEqual([])
      expect(respellings('p.ts', 'while (ts.isAwaitExpression(i)) i = i.expression')).toEqual([])
      expect(respellings('p.ts', 'for (const a of list) { ts.isAsExpression(a) }')).toEqual([])
      expect(respellings('p.ts', 'while (isTypeOnlyWrapper(c.parent)) c = c.parent')).toEqual([])
    })

    it('sees a hand-written import walk, however it reaches the bindings', () => {
      const walks = [
        'const b = statement.importClause?.namedBindings',
        'if (ts.isNamedImports(b)) use(b)',
        'if (ts.isNamespaceImport(b)) use(b.name)',
        'if (ts.isImportClause(n)) use(n.name)',
        'if (ts.isImportSpecifier(node)) use(node.propertyName ?? node.name)',
        'if (n.kind === ts.SyntaxKind.ImportSpecifier) use(n)',
      ]
      for (const walk of walks) {
        expect(new Set(respellings('p.ts', walk)), walk).toEqual(
          new Set(['walks an import by hand']),
        )
      }
    })

    it('leaves a name-slot question, an export walk and a call of the helper alone', () => {
      expect(respellings('p.ts', 'const slot = ts.isImportSpecifier(parent)')).toEqual([])
      expect(respellings('p.ts', 'const slot = ts.isImportSpecifier(node.parent)')).toEqual([])
      expect(
        respellings('p.ts', 'for (const e of clause.elements) use(e.propertyName ?? e.name)'),
      ).toEqual([])
      expect(respellings('p.ts', "const b = importedBindings(file, isFs, 'rename')")).toEqual([])
    })

    it('leaves a differently named helper and a call alone', () => {
      expect(respellings('p.ts', 'function unwrapAwait(n: N) { return n }')).toEqual([])
      expect(respellings('p.ts', 'const k = parseSource(f, text)')).toEqual([])
      expect(respellings('p.ts', 'const k = createSourceFileList(f)')).toEqual([])
    })
  })
})
