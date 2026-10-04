import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { collectModuleSpecifiers, scanSourceForBoundaryViolations } from './scanner.js'

function violationKinds(source: string) {
  return scanSourceForBoundaryViolations('fixture.ts', source).map((v) => v.kind)
}

describe('scanSourceForBoundaryViolations', () => {
  it('flags a bare node builtin static import', () => {
    expect(violationKinds("import fs from 'fs'")).toContain('node-builtin-import')
  })

  it('flags a node: prefixed builtin import', () => {
    expect(violationKinds("import fs from 'node:fs'")).toContain('node-builtin-import')
  })

  it('flags a node builtin subpath import', () => {
    expect(violationKinds("import fs from 'node:fs/promises'")).toContain('node-builtin-import')
  })

  it('flags an inversify import', () => {
    expect(violationKinds("import { injectable } from 'inversify'")).toContain('inversify-import')
  })

  it('flags a loro-crdt import', () => {
    expect(violationKinds("import { LoroDoc } from 'loro-crdt'")).toContain('loro-crdt-import')
  })

  it('flags a loro-crdt subpath import', () => {
    expect(violationKinds("import { LoroDoc } from 'loro-crdt/base64'")).toContain(
      'loro-crdt-import',
    )
  })

  it('flags a node builtin in export * from', () => {
    expect(violationKinds("export * from 'node:path'")).toContain('node-builtin-import')
  })

  it('flags a node builtin in export {x} from', () => {
    expect(violationKinds("export { join } from 'node:path'")).toContain('node-builtin-import')
  })

  it('flags a node builtin in dynamic import()', () => {
    expect(violationKinds("const fs = await import('node:fs')")).toContain('node-builtin-import')
  })

  it('flags each DOM-global identifier', () => {
    for (const id of [
      'window',
      'document',
      'navigator',
      'localStorage',
      'indexedDB',
      'HTMLElement',
      'HTMLCanvasElement',
      'HTMLImageElement',
      'OffscreenCanvas',
    ]) {
      expect(violationKinds(`const x = ${id}`)).toContain('dom-global')
    }
  })

  it('flags each bare Node ambient global', () => {
    for (const id of ['process', 'Buffer', '__dirname', '__filename', 'global']) {
      expect(violationKinds(`const x = ${id}`)).toContain('node-ambient-global')
    }
  })

  it('does not flag the declaration site of a locally-named binding that shadows a banned name', () => {
    // This scanner is a real-AST walk, not a scope-resolving type checker —
    // it deliberately does not attempt to disambiguate a later *reference*
    // to a shadowed local from a reference to the actual ambient global
    // (that needs a binder/checker, out of scope here); it only avoids
    // flagging the declaration's own name node.
    expect(violationKinds('const process = 1')).toHaveLength(0)
  })

  it('does not flag a property access with a banned-name key', () => {
    expect(violationKinds('const x = { window: 1 }; const y = x.window')).toHaveLength(0)
  })

  it("does not flag `declare global`'s keyword, while a real global read still fires", () => {
    // The ambient-augmentation block is a type-level construct whose
    // identifier is the ModuleDeclaration's NAME — reading Node's `global`
    // object is a different AST position and must keep firing.
    expect(violationKinds('declare global { interface Window { x?: string } }')).toHaveLength(0)
    expect(violationKinds('const g = global')).toContain('node-ambient-global')
  })

  it('flags a banned global used as the object of a member access', () => {
    expect(violationKinds('const y = window.location.href')).toContain('dom-global')
    expect(violationKinds('const t = document.title')).toContain('dom-global')
    expect(violationKinds('const e = process.env.FOO')).toContain('node-ambient-global')
    expect(violationKinds('const b = Buffer.from("x")')).toContain('node-ambient-global')
  })

  it.each([
    ['a template-literal dynamic import', 'const fs = await import(`node:fs`)'],
    ['a require() call', "const fs = require('node:fs')"],
    ['a template-literal require() call', 'const fs = require(`node:fs`)'],
    ['an import-equals require', "import fs = require('node:fs')"],
    ['a double-quoted dynamic import', 'const fs = await import("node:fs")'],
  ])('flags a node builtin reached through %s', (_name, source) => {
    expect(violationKinds(source)).toContain('node-builtin-import')
  })

  it('does not read a dynamic import whose specifier is computed', () => {
    // Named blind spot: a substitution names no module statically.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the SOURCE UNDER TEST is a template literal with a substitution, not a placeholder of this one
    expect(violationKinds('const m = await import(`node:${name}`)')).toHaveLength(0)
    expect(violationKinds('const m = await import(name)')).toHaveLength(0)
  })

  it.each([
    'inversify',
    'inversify/lib/x',
    '@inversifyjs/core',
    '@inversifyjs/container',
  ])('flags the inversify specifier %s', (specifier) => {
    expect(violationKinds(`import x from '${specifier}'`)).toContain('inversify-import')
  })

  it('does not take a package that merely starts with inversify for inversify', () => {
    expect(violationKinds("import x from 'inversify-like'")).toHaveLength(0)
  })

  it('flags a banned global read through globalThis', () => {
    expect(violationKinds('const t = globalThis.document.title')).toContain('dom-global')
    expect(violationKinds('const e = globalThis.process.env.X')).toContain('node-ambient-global')
    expect(violationKinds('const w = globalThis.window')).toContain('dom-global')
  })

  it('does not flag globalThis reads of an unbanned name', () => {
    expect(violationKinds('const f = globalThis.fetch')).toHaveLength(0)
  })

  it.each([
    'vitest',
    'vitest/config',
    '@vitest/browser',
    'fast-check',
    '@fast-check/vitest',
    '@testing-library/react',
    '@testing-library/dom',
    '@testing-library/user-event',
  ])('flags a test framework import of %s', (specifier) => {
    expect(violationKinds(`import { x } from '${specifier}'`)).toContain('test-framework-import')
  })

  it('does not take a package that merely starts with vitest for the framework', () => {
    expect(violationKinds("import x from 'vitest-like'")).toHaveLength(0)
    expect(violationKinds("import x from '@testing-library-like/react'")).toHaveLength(0)
  })

  it('passes clean on compliant source with no banned constructs', () => {
    expect(violationKinds("import { z } from 'zod'\nexport const x = z.string()")).toHaveLength(0)
  })
})

describe('scanSourceForBoundaryViolations — type-position and directive specifiers', () => {
  it.each([
    ['a typeof import type', "type Fs = typeof import('node:fs')"],
    ['an import type with a member', "type S = import('node:stream').Readable"],
    ['a generic import type', "type S = import('node:stream').Transform<string>"],
    ['a template-literal import type', 'type Fs = typeof import(`node:fs`)'],
    ['an import type nested in a signature', "function f(x: Array<import('node:fs').Stats>) {}"],
    ['a types reference directive naming node', '/// <reference types="node" />\nexport {}'],
    ['a types reference directive naming @types/node', '/// <reference types="@types/node" />'],
  ])('flags a node builtin reached through %s', (_name, source) => {
    expect(violationKinds(source)).toContain('node-builtin-import')
  })

  it('flags an inversify or loro-crdt module named in an import type', () => {
    expect(violationKinds("type C = import('inversify').Container")).toContain('inversify-import')
    expect(violationKinds("type D = typeof import('loro-crdt')")).toContain('loro-crdt-import')
  })

  it('reports the 1-based line an import type is on', () => {
    const source = ['const a = 1', '', "type Fs = typeof import('node:fs')"].join('\n')
    const found = scanSourceForBoundaryViolations('fixture.ts', source)
    expect(found.map((v) => [v.name, v.line])).toEqual([['node:fs', 3]])
  })

  it('does not read an import type whose specifier is computed or absent', () => {
    expect(violationKinds('type T = import(string)')).toEqual([])
  })

  it('collects an import type as a type-only edge and a reference path as a relative one', () => {
    const sourceFile = ts.createSourceFile(
      'fixture.ts',
      [
        '/// <reference path="./ambient.d.ts" />',
        '/// <reference path="ambient-bare.d.ts" />',
        '/// <reference types="vite/client" />',
        "type A = typeof import('../x.js')",
        "type B = import('./y.js').B",
        "const c = await import('./z.js')",
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    )
    expect(
      collectModuleSpecifiers(sourceFile).map(({ specifier, typeOnly, line }) => [
        specifier,
        typeOnly,
        line,
      ]),
    ).toEqual([
      ['./ambient.d.ts', true, 1],
      ['./ambient-bare.d.ts', true, 2],
      ['vite/client', true, 3],
      ['../x.js', true, 4],
      ['./y.js', true, 5],
      ['./z.js', false, 6],
    ])
  })

  it('leaves a lib reference directive alone: it names no module', () => {
    expect(violationKinds('/// <reference lib="es2022" />')).toEqual([])
  })
})

describe('scanSourceForBoundaryViolations — edges the other cases do not reach', () => {
  it('flags a node: builtin that has no bare spelling', () => {
    expect(violationKinds("import { DatabaseSync } from 'node:sqlite'")).toContain(
      'node-builtin-import',
    )
    expect(violationKinds("import test from 'node:test'")).toContain('node-builtin-import')
  })

  it('does not take a package that merely ends in node: for a builtin', () => {
    expect(violationKinds("import x from 'not-node:'")).toEqual([])
  })

  it('an empty named import still evaluates its module, so it is a value edge', () => {
    expect(violationKinds("import {} from 'node:fs'")).toContain('node-builtin-import')
    expect(violationKinds("export {} from 'node:fs'")).toContain('node-builtin-import')
  })

  it('a mixed import is a value edge: one type-only binding does not exempt the rest', () => {
    expect(violationKinds("import { type A, readFileSync } from 'node:fs'")).toContain(
      'node-builtin-import',
    )
    expect(violationKinds("export { type A, readFileSync } from 'node:fs'")).toContain(
      'node-builtin-import',
    )
  })

  it('reports the 1-based line a banned global is read on', () => {
    const source = ['const a = 1', '', 'const b = window.location', 'const c = 2'].join('\n')
    const found = scanSourceForBoundaryViolations('fixture.ts', source)
    expect(found.map((v) => [v.name, v.line])).toEqual([['window', 3]])
  })
})

describe('collectModuleSpecifiers: a URL resolved against import.meta.url', () => {
  const specifiersOf = (text: string) =>
    collectModuleSpecifiers(
      ts.createSourceFile('fixture.ts', text, ts.ScriptTarget.Latest, true),
    ).map(({ specifier, typeOnly }) => [specifier, typeOnly])

  it('reads the file a worker is built from as a value edge', () => {
    expect(
      specifiersOf(
        [
          "const w = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module' })",
          "const s = new SharedWorker(new URL('../sse-shared-worker.js', import.meta.url))",
        ].join('\n'),
      ),
    ).toEqual([
      ['./layout-worker.ts', false],
      ['../sse-shared-worker.js', false],
    ])
  })

  it('writes a bare file name the way an import of it would be', () => {
    expect(specifiersOf("new URL('worker.ts', import.meta.url)")).toEqual([['./worker.ts', false]])
  })

  it('leaves a URL with another base, a scheme, a root path or a computed name alone', () => {
    expect(
      specifiersOf(
        [
          "new URL('./x.ts', base)",
          "new URL('./x.ts')",
          "new URL('https://example.com/x.js', import.meta.url)",
          "new URL('/x.js', import.meta.url)",
          'new URL(name, import.meta.url)',
          "new URL('./x.ts', import.meta.dirname)",
        ].join('\n'),
      ),
    ).toEqual([])
  })
})
