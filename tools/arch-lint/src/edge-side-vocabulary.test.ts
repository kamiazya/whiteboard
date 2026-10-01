/**
 * The four sides of a node an edge can attach to are ONE vocabulary, declared
 * once in `packages/model` as `edgeSideSchema` and read everywhere else
 * through `EdgeSide`. A second spelling — a `'top' | 'right' | …` union, a
 * `z.enum`, a literal array — compiles and parses today, and drifts the day
 * a fifth side (or a renamed one) is added to the first: the stored shape
 * would accept what the scene vocabulary refuses.
 *
 * The scan reads every non-test source file under `packages/*` and `apps/*`
 * with comments and strings stripped except for single-word strings, so a
 * sentence naming the sides is not mistaken for a declaration.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const THE_DECLARATION = 'packages/model/src/spatial.ts'

const SIDES = ['top', 'right', 'bottom', 'left'] as const

/** Three separators between four side literals, in any order. */
const SIDE_LITERAL = `'(?:${SIDES.join('|')})'`
const FOUR_SIDES = new RegExp(`(?:${SIDE_LITERAL}\\s*[|,]\\s*){3}${SIDE_LITERAL}`, 'g')

function sourceRoots(): string[] {
  return ['packages', 'apps'].flatMap((group) =>
    readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(REPO_ROOT, group, entry.name, 'src'))
      .filter((dir) => {
        try {
          readdirSync(dir)
          return true
        } catch {
          return false
        }
      }),
  )
}

function declarations(): { readonly files: number; readonly found: readonly string[] } {
  const files = sourceRoots()
    .flatMap((dir) => walkSourceFiles(dir))
    .filter((file) => !isTestPath(file))
  const found: string[] = []
  for (const file of files) {
    const code = stripCommentsAndStrings(readFileSync(file, 'utf8'))
    for (const match of code.matchAll(FOUR_SIDES)) {
      const named = SIDES.filter((side) => match[0].includes(`'${side}'`))
      if (named.length === SIDES.length) {
        found.push(relative(REPO_ROOT, file).split(sep).join('/'))
      }
    }
  }
  return { files: files.length, found }
}

describe('the edge side vocabulary', () => {
  const { files, found } = declarations()

  it('scans a real population', () => {
    expect(files).toBeGreaterThan(1000)
  })

  it('recognises a declaration, so a pattern matching nothing cannot pass', () => {
    expect(found).toContain(THE_DECLARATION)
  })

  it('is declared once, in the model', () => {
    expect(found).toEqual([THE_DECLARATION])
  })
})
