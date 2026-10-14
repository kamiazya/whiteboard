import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import {
  type ImportedBindingsOptions,
  importBindingsOf,
  importedBindings,
  parseSource,
  scriptKindOf,
  unwrapExpression,
} from './ast-helpers.js'

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

describe('importBindingsOf', () => {
  it('names every binding with what it imports and from where', () => {
    const file = parseSource(
      'p.ts',
      [
        "import d, { a, b as c, type T } from './m.js'",
        "import * as ns from 'node:fs'",
        "import type { U } from './types.js'",
        "import './side-effect.js'",
      ].join('\n'),
    )
    expect(
      importBindingsOf(file).map(({ local, imported, kind, spec, typeOnly }) => ({
        local,
        imported,
        kind,
        spec,
        typeOnly,
      })),
    ).toEqual([
      { local: 'd', imported: 'default', kind: 'default', spec: './m.js', typeOnly: false },
      { local: 'a', imported: 'a', kind: 'named', spec: './m.js', typeOnly: false },
      { local: 'c', imported: 'b', kind: 'named', spec: './m.js', typeOnly: false },
      { local: 'T', imported: 'T', kind: 'named', spec: './m.js', typeOnly: true },
      { local: 'ns', imported: '*', kind: 'namespace', spec: 'node:fs', typeOnly: false },
      { local: 'U', imported: 'U', kind: 'named', spec: './types.js', typeOnly: true },
    ])
  })
})

describe('importedBindings', () => {
  const isFs = (spec: string) => spec === 'node:fs'
  const of = (source: string, options?: ImportedBindingsOptions) => {
    const found = importedBindings(parseSource('p.ts', source), isFs, 'rename', options)
    return {
      locals: [...found.locals.keys()],
      namespaces: [...found.namespaces.keys()],
      reexports: [...found.reexports],
    }
  }
  const none = { locals: [], namespaces: [], reexports: [] }

  it.each([
    ['a named import', "import { rename } from 'node:fs'", { ...none, locals: ['rename'] }],
    ['an aliased import', "import { rename as mv } from 'node:fs'", { ...none, locals: ['mv'] }],
    ['a namespace import', "import * as fs from 'node:fs'", { ...none, namespaces: ['fs'] }],
    ['a default import, by default', "import fs from 'node:fs'", none],
    ['a named re-export', "export { rename as mv } from 'node:fs'", { ...none, reexports: ['mv'] }],
    ['another export of the module', "import { stat } from 'node:fs'", none],
    ['the export from another module', "import { rename } from './fs.js'", none],
    ['a type-only import', "import type { rename } from 'node:fs'", none],
    ['a type-only specifier', "import { type rename } from 'node:fs'", none],
    ['a type-only namespace', "import type * as fs from 'node:fs'", none],
    ['a type-only re-export', "export type { rename } from 'node:fs'", none],
    ['a type-only re-exported specifier', "export { type rename } from 'node:fs'", none],
    ['a re-export from another module', "export { rename } from './fs.js'", none],
  ])('reads %s', (_label, source, expected) => {
    expect(of(source)).toEqual(expected)
  })

  it('reads a default import as the namespace when the module says so', () => {
    expect(of("import fs from 'node:fs'", { defaultIsNamespace: true })).toEqual({
      ...none,
      namespaces: ['fs'],
    })
  })

  it('reads a default import as the export when the export asked for is `default`', () => {
    const found = importedBindings(parseSource('p.ts', "import x from 'node:fs'"), isFs, 'default')
    expect([...found.locals.keys()]).toEqual(['x'])
  })

  it('counts type-only bindings when asked', () => {
    expect(of("import type { rename } from 'node:fs'", { includeTypeOnly: true })).toEqual({
      ...none,
      locals: ['rename'],
    })
    expect(of("export type { rename } from 'node:fs'", { includeTypeOnly: true })).toEqual({
      ...none,
      reexports: ['rename'],
    })
  })

  it('takes a set of export names, and answers the node that binds each local', () => {
    const file = parseSource('p.ts', "import { rename, renameSync as rs } from 'node:fs'")
    const found = importedBindings(file, isFs, new Set(['rename', 'renameSync']))
    expect([...found.locals.keys()]).toEqual(['rename', 'rs'])
    expect([...found.locals.values()]).toEqual(importBindingsOf(file).map((b) => b.node))
  })
})
