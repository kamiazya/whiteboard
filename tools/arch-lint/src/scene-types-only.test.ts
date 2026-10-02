import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, relativeToRepo } from './scan-roots.js'
import { walkSourceFiles } from './source-scan.js'

/**
 * `packages/scene` exists for its POSITION, below the renderer and every
 * plugin, and is held to emitting no code: a const or a function there would be
 * code both sides SHARE, which is a different kind of package with different
 * rules. That is asked of the compiler. A regex over `export (const|function|…)`
 * passed an `async function`, an `abstract class`, a default export, a local
 * re-exported by name and a `namespace`, each of which emits.
 */
const SCENE_SRC = join(REPO_ROOT, 'packages', 'scene', 'src')

/**
 * The statements `source` still has after TypeScript erases everything with no
 * runtime form, other than re-exports from a sibling module (each sibling is
 * judged on its own).
 */
function runtimeStatements(source: string): string[] {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    reportDiagnostics: false,
  })
  const emitted = ts.createSourceFile('emitted.js', outputText, ts.ScriptTarget.ESNext, true)
  return emitted.statements
    .filter((statement) => {
      if (!ts.isExportDeclaration(statement)) return true
      const { moduleSpecifier, exportClause } = statement
      if (moduleSpecifier === undefined) {
        // `export {}`: the marker transpile leaves on a module with nothing in it.
        return !(
          exportClause !== undefined &&
          ts.isNamedExports(exportClause) &&
          exportClause.elements.length === 0
        )
      }
      return !(ts.isStringLiteral(moduleSpecifier) && moduleSpecifier.text.startsWith('./'))
    })
    .map((statement) => statement.getText(emitted))
}

describe("packages/scene's vocabulary is types only", () => {
  const emits = (source: string): boolean => runtimeStatements(source).length > 0

  it('sees every form of runtime export', () => {
    expect(emits('export const x = 1')).toBe(true)
    expect(emits('export async function f() { return 1 }')).toBe(true)
    expect(emits('export abstract class C {}')).toBe(true)
    expect(emits('export default 1')).toBe(true)
    expect(emits('const x = 2\nexport { x }')).toBe(true)
    expect(emits('export namespace N { export const i = 1 }')).toBe(true)
    expect(emits('export enum E { A }')).toBe(true)
    expect(emits("export * from '@kamiazya/whiteboard-model'")).toBe(true)
    expect(emits("import './side-effect.js'")).toBe(true)
  })

  it('passes what is erased, and a re-export of a sibling', () => {
    expect(emits('export interface I { a: number }\nexport type T = I | string')).toBe(false)
    expect(emits("import type { M } from '@kamiazya/whiteboard-model'\nexport type U = M")).toBe(
      false,
    )
    expect(
      emits("export type { I } from './scene-graph.js'\nexport * from './scene-graph.js'"),
    ).toBe(false)
    expect(emits('export declare const d: number')).toBe(false)
  })

  it('emits no runtime code from any source file', () => {
    const files = walkSourceFiles(SCENE_SRC).filter((file) => !/\.test\.tsx?$/.test(file))
    // An empty walk agrees with the rule, and reads as a package that emits nothing.
    expect(files.length).toBeGreaterThan(2)
    for (const file of files) {
      expect(
        runtimeStatements(readFileSync(file, 'utf8')),
        `${relativeToRepo(file)} emits runtime code`,
      ).toEqual([])
    }
  })
})
