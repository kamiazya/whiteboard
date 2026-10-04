/**
 * This tool's guards read source through `ast-helpers.ts`, and nothing else
 * writes out the two steps every one of them takes: choose the parser mode from
 * the extension, and look through the wrappers that change an expression's type
 * and not its value.
 *
 * Both were spelled at half a dozen guards each, and the copies had already
 * diverged — one skipped `as` and `satisfies`, so `(save as Fn)(doc)` was not
 * the call it is. A guard that cannot see a call reports clean, which reads
 * exactly like one that looked.
 *
 * Read from the syntax tree: a function by one of the helpers' names, or a
 * `ScriptKind.TSX` chosen by a ternary, defined anywhere but `ast-helpers.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource } from './ast-helpers.js'

const OWNER = 'ast-helpers.ts'
const HELPER_NAME = /^(unwrap(Expression)?|scriptKind(Of)?)$/

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
    expect(respelled, `use ${OWNER}: scriptKindOf / unwrapExpression / parseSource`).toEqual([])
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

    it('leaves a differently named helper and a call alone', () => {
      expect(respellings('p.ts', 'function unwrapAwait(n: N) { return n }')).toEqual([])
      expect(respellings('p.ts', 'const k = parseSource(f, text)')).toEqual([])
    })
  })
})
