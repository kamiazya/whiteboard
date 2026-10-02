import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, relativeToRepo } from './scan-roots.js'

// The distribution smokes are plain Node scripts that run only on the
// release path, so a helper copied into each one is copied for good: nothing
// that runs on a pull request executes the second copy, and the four JWT and
// TLS helpers drifted apart in comment and spelling while staying equivalent
// by luck. `smoke-helpers.mjs` is the one home; a function declared at the
// top level of two scripts there means a helper was pasted instead of
// imported.
//
// A name shared by two files is the whole finding, not a byte comparison of
// the bodies: two copies that differ are the worse case, because they are
// what a later reader merges wrongly. Where scripts need a variation, the
// helper takes it as a parameter.
//
// A call to a factory (`const fail = createFail('label')`) is not a function
// declaration, so a script binds a shared helper to its own label without
// being counted as re-declaring it.
const SMOKE_DIR = 'tests/e2e/distribution'

function smokeScripts(): string[] {
  return readdirSync(join(REPO_ROOT, SMOKE_DIR))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => join(SMOKE_DIR, name))
    .sort()
}

function isFunctionValued(initializer: ts.Expression | undefined): boolean {
  return (
    initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  )
}

/** Names declared as functions at the top level of one script. */
function topLevelFunctionNames(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  )
  const names: string[] = []
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      names.push(statement.name.text)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && isFunctionValued(declaration.initializer)) {
          names.push(declaration.name.text)
        }
      }
    }
  }
  return names
}

function declarationsByScript(): Map<string, string[]> {
  return new Map(
    smokeScripts().map((path) => [
      path,
      topLevelFunctionNames(readFileSync(join(REPO_ROOT, path), 'utf8'), path),
    ]),
  )
}

describe('distribution smokes declare each helper in one place', () => {
  const declarations = declarationsByScript()

  // A scan whose glob or parser stopped matching would find no duplicate in
  // an empty set, which reads exactly like a clean directory.
  it('reaches the smoke scripts and the functions they declare', () => {
    const total = [...declarations.values()].reduce((sum, names) => sum + names.length, 0)
    expect(declarations.size).toBeGreaterThan(10)
    expect(total).toBeGreaterThan(40)
  })

  it('declares no function name in more than one script', () => {
    const owners = new Map<string, string[]>()
    for (const [path, names] of declarations) {
      for (const name of new Set(names)) owners.set(name, [...(owners.get(name) ?? []), path])
    }
    const duplicated = [...owners]
      .filter(([, paths]) => paths.length > 1)
      .map(
        ([name, paths]) =>
          `${name}: ${paths.map((p) => relativeToRepo(join(REPO_ROOT, p))).join(', ')}`,
      )
    expect(duplicated).toEqual([])
  })

  it('counts a function declaration and a function-valued const, and nothing else', () => {
    const text = [
      'export function a() {}',
      'async function b() {}',
      'const c = () => 1',
      'const d = async function () {}',
      'const e = makeIt()',
      'function outer() { function inner() {} }',
    ].join('\n')
    expect(topLevelFunctionNames(text, 'x.mjs')).toEqual(['a', 'b', 'c', 'd', 'outer'])
  })
})
