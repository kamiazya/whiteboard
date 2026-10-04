import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource, scriptKindOf, unwrapExpression } from './ast-helpers.js'

// Each guard that imports these pins only the wrappers its own fixtures happen
// to use; this is the one place all five are held.
function initializerOf(source: string, fileName = 'p.ts'): ts.Expression {
  const file = parseSource(fileName, source)
  const statement = file.statements[0]
  if (statement === undefined || !ts.isVariableStatement(statement)) throw new Error('fixture')
  const initializer = statement.declarationList.declarations[0]?.initializer
  if (initializer === undefined) throw new Error('fixture')
  return initializer
}

describe('unwrapExpression', () => {
  it.each([
    ['parentheses', 'const k = (save)'],
    ['as', 'const k = save as Fn'],
    ['satisfies', 'const k = save satisfies Fn'],
    ['non-null', 'const k = save!'],
    ['angle-bracket assertion', 'const k = <Fn>save'],
    ['all five, nested', 'const k = ((<Fn>(save! satisfies Fn)) as Fn)'],
  ])('looks through %s', (_label, source) => {
    const inner = unwrapExpression(initializerOf(source, 'p.ts'))
    expect(ts.isIdentifier(inner) && inner.text).toBe('save')
  })

  it('stops at an expression that is not a wrapper', () => {
    const inner = unwrapExpression(initializerOf('const k = (save as Fn)(doc)'))
    expect(ts.isCallExpression(inner)).toBe(true)
  })

  it('returns an expression with no wrapper unchanged', () => {
    const plain = initializerOf('const k = save')
    expect(unwrapExpression(plain)).toBe(plain)
  })
})

describe('scriptKindOf and parseSource', () => {
  it('chooses TSX for .tsx and .jsx and plain TS otherwise', () => {
    expect(scriptKindOf('a.tsx')).toBe(ts.ScriptKind.TSX)
    expect(scriptKindOf('a.jsx')).toBe(ts.ScriptKind.TSX)
    expect(scriptKindOf('a.ts')).toBe(ts.ScriptKind.TS)
    expect(scriptKindOf('a.mjs')).toBe(ts.ScriptKind.TS)
    expect(scriptKindOf('tsx-notes.ts')).toBe(ts.ScriptKind.TS)
  })

  it('parses JSX in a .tsx file and carries parent pointers unless told not to', () => {
    const file = parseSource('a.tsx', 'const k = <div />')
    const statement = file.statements[0]
    expect(statement?.parent).toBe(file)
    expect(parseSource('a.ts', 'const k = 1', false).statements[0]?.parent).toBeUndefined()
  })
})
