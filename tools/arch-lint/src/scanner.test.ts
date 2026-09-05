import { describe, expect, it } from 'vitest'
import { scanSourceForBoundaryViolations } from './scanner.js'

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

  it('passes clean on compliant source with no banned constructs', () => {
    expect(violationKinds("import { z } from 'zod'\nexport const x = z.string()")).toHaveLength(0)
  })
})
