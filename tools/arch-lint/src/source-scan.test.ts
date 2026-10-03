/**
 * The scanners' shared stripper, tested directly.
 *
 * It exists because `stripComments` was copied between arch-lint scans and
 * one copy had a bug the other did not. A `/` was only ever a comment or
 * division, so a REGEX LITERAL containing a quote opened a "string" that ran
 * to the next quote far below and blanked the rest of the file.
 *
 * `packages/mcp-server/src/server/security/bearer-token.ts` is the real one:
 * it holds `/[\s,"]/`, and everything after it — including `isAuthorized`'s
 * own declaration — was invisible to a scan using the old copy. The failure
 * is in the dangerous direction, because a scan that cannot see a file
 * reports it clean.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import ts from '@typescript/typescript6'
import { afterEach, describe, expect, it } from 'vitest'
import { isExcludedPath, relativeToRepo, SCAN_ROOTS, walk } from './scan-roots.js'
import {
  classifyPath,
  isShippedPath,
  isTestPath,
  type PathCategory,
  stripCommentsAndStrings,
  walkSourceFiles,
} from './source-scan.js'

describe('stripCommentsAndStrings — a regex literal is not a string', () => {
  // The exact shape that regressed, for both scan families: a seam
  // definition (reference-seams) and a primitive call (credential
  // verification) sitting AFTER a regex whose character class holds a quote.
  it('leaves code after a regex containing a double quote visible', () => {
    const source = [
      'const strip = /[\\s,"]/',
      'const seams = {',
      '  resolveAlias: (id) => id,',
      '}',
    ].join('\n')

    const stripped = stripCommentsAndStrings(source)

    expect(stripped).toContain('resolveAlias')
    expect(/resolveAlias\s*:\s*\([^)]*\)\s*=>/.test(stripped)).toBe(true)
  })

  it('leaves code after a regex containing a single quote visible', () => {
    const source = ["const q = /'/", 'export function gate() { return isAuthorized(h, t) }'].join(
      '\n',
    )

    expect(stripCommentsAndStrings(source)).toContain('isAuthorized(')
  })

  // A slash inside a CHARACTER CLASS does not close the literal. Treating
  // it as the terminator ends the regex early, and everything from there to
  // the real terminator is then read as code — so the pattern's own text
  // starts matching whatever a scan is looking for. Surfaced by a mutation
  // that removed the `inClass` guard and left every other case green.
  it('does not end a regex at a slash inside a character class', () => {
    const source = ['const sep = /[/]/', 'const call = isAuthorized(h, t)'].join('\n')

    const stripped = stripCommentsAndStrings(source)

    expect(stripped).toContain('isAuthorized(')
    // The WHOLE literal is consumed, so the line it sat on keeps only what
    // came before it. Ending the regex at the inner slash instead leaves the
    // class's tail (`]/`) behind as code.
    expect(stripped.split('\n')[0]).toBe('const sep = ')
  })

  // Division must not be mistaken for a regex opening, or the stripper eats
  // real code from the slash onwards — the same blindness, other way round.
  it('does not treat division as a regex', () => {
    const source = 'const ratio = total / count\nconst call = isAuthorized(h, t)'

    const stripped = stripCommentsAndStrings(source)

    expect(stripped).toContain('total / count')
    expect(stripped).toContain('isAuthorized(')
  })
})

describe('stripCommentsAndStrings — what it still removes', () => {
  it('blanks prose so a comment naming a call is not read as one', () => {
    const source = '// call isAuthorized(x) here\nconst y = 1'

    expect(stripCommentsAndStrings(source)).not.toContain('isAuthorized')
  })

  it('blanks a string body so quoted prose is not read as code', () => {
    const source = 'const note = "we call isAuthorized(x) in the resolver"'

    expect(stripCommentsAndStrings(source)).not.toContain('isAuthorized(')
  })

  it('does not let a slash-slash inside a string swallow the code after it', () => {
    const source = 'const url = "https://example.test"\nconst call = isAuthorized(h, t)'

    expect(stripCommentsAndStrings(source)).toContain('isAuthorized(')
  })

  // A lone identifier survives, because it may be a quoted object key and a
  // scan looking for keys has to still see it.
  it('keeps a string body that is a single identifier', () => {
    expect(stripCommentsAndStrings("const k = { 'resolveAlias': 1 }")).toContain('resolveAlias')
  })
})

// Code inside a template's `${…}` is code. The stripper used to read a
// substitution as part of the string, so a call there was invisible to every
// guard built on it, and a template nested in a substitution flipped every
// later backtick.
describe('stripCommentsAndStrings — what the parser knows and a char scan does not', () => {
  it('keeps a call inside a template substitution', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the probe is source text
    const stripped = stripCommentsAndStrings('const a = `x ${isAuthorized(h, t)} y`')

    expect(stripped).toContain('isAuthorized(h, t)')
    expect(stripped).not.toContain('x ')
  })

  it('stays in sync across a template nested in a substitution', () => {
    const source = [
      // The shape `daemon/native-host/install.ts` quotes a shell argument with.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the probe is source text
      "const q = `'${value.replaceAll(\"'\", `'\\\\''`)}'`",
      'const after = isAuthorized(h, t)',
    ].join('\n')

    const stripped = stripCommentsAndStrings(source)

    expect(stripped).toContain('replaceAll(')
    expect(stripped.split('\n')[1]).toBe('const after = isAuthorized(h, t)')
  })

  it('keeps code after a JSX closing tag on the same line', () => {
    const source = 'const a = <A>{x}</A>; const b = <B>{readSpatialCanvas(doc)}</B>'

    expect(stripCommentsAndStrings(source)).toContain('readSpatialCanvas(doc)')
  })

  it('reads a slash after a closing parenthesis as a regex when the grammar says so', () => {
    const source = ['if (x) /re"/.test(y)', 'isAuthorized(h)'].join('\n')

    const stripped = stripCommentsAndStrings(source)

    expect(stripped).toContain('.test(y)')
    expect(stripped).toContain('isAuthorized(h)')
  })

  // `<Foo>bar` is a type assertion to a .ts grammar and an unclosed element
  // to a .tsx one, which then reads on to the next `</`.
  it('reads a type assertion as one when the file is .ts, named or not', () => {
    const source = 'const a = <Foo>bar\nconst b = isAuthorized(h)'

    expect(stripCommentsAndStrings(source, 'a.ts')).toContain('isAuthorized(h)')
    expect(stripCommentsAndStrings(source)).toContain('isAuthorized(h)')
  })

  it('reads JSX as JSX when the file is .tsx, named or not', () => {
    const source = 'const a = <A>{x}</A>\nconst b = isAuthorized(h)'

    expect(stripCommentsAndStrings(source, 'a.tsx')).toContain('isAuthorized(h)')
    expect(stripCommentsAndStrings(source)).toContain('isAuthorized(h)')
  })
})

/**
 * Every call name a file's syntax tree holds must still be a call in what the
 * stripper leaves, as many times. The tree is the reference: the stripper may
 * drop prose, never code, and the failure is invisible from the inside because
 * a guard that cannot see a call reports clean. Read back through the parser
 * rather than a `name(` pattern, which loses `useRef<() => void>(…)`.
 */
function callNames(path: string, source: string): Map<string, number> {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
  const calls = new Map<string, number>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined
      if (name !== undefined) {
        const bare = name.replace(/^#/, '')
        calls.set(bare, (calls.get(bare) ?? 0) + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

describe('stripCommentsAndStrings — keeps every call the syntax tree holds', () => {
  const files = SCAN_ROOTS.flatMap((root) =>
    walk(join(import.meta.dirname, '..', '..', '..', root), {
      include: (path) => /\.tsx?$/.test(path) && !isExcludedPath(path),
      skip: (_path, name) => name === 'node_modules' || name === 'dist' || name === 'tmp',
    }),
  )

  it('is looking at the tree', () => {
    expect(files.length).toBeGreaterThan(1500)
  })

  it('loses no call in any source file', () => {
    const lost: string[] = []
    for (const path of files) {
      const source = readFileSync(path, 'utf8')
      const shown = callNames(path, stripCommentsAndStrings(source, path))
      for (const [name, count] of callNames(path, source)) {
        if ((shown.get(name) ?? 0) < count) lost.push(`${relativeToRepo(path)}: ${name}`)
      }
    }
    expect(lost).toEqual([])
  }, 300_000)
})

// A package's `tmp/` is where a crashed or interrupted Stryker run leaves a
// whole copy of the package's `src`, git-ignored and still on disk. A walk
// that descends into it reads every file twice, and a rule that wants exactly
// one definition of something fails on the copy.
describe('walkSourceFiles', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function tree(files: readonly string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'source-scan-'))
    roots.push(root)
    for (const file of files) {
      mkdirSync(join(root, file, '..'), { recursive: true })
      writeFileSync(join(root, file), 'export const x = 1\n')
    }
    return root
  }

  const walked = (root: string): string[] =>
    walkSourceFiles(root)
      .map((path) => relative(root, path).split('\\').join('/'))
      .sort()

  it('reads .ts and .tsx source and nothing else', () => {
    const root = tree(['src/a.ts', 'src/b.tsx', 'src/c.md', 'src/d.js'])
    expect(walked(root)).toEqual(['src/a.ts', 'src/b.tsx'])
  })

  it('skips node_modules, dist and tmp at any depth', () => {
    const root = tree([
      'src/a.ts',
      'node_modules/dep/index.ts',
      'dist/index.ts',
      'tmp/stryker-sandbox/sandbox-1/src/a.ts',
      'pkg/tmp/probe/src/shared/redact.ts',
    ])
    expect(walked(root)).toEqual(['src/a.ts'])
  })
})

describe('classifyPath — what a path is to the build', () => {
  const CASES: ReadonlyArray<readonly [PathCategory, readonly string[]]> = [
    ['test', ['a/src/x.test.ts', 'a/src/x.spec.tsx', 'a/src/x.browser.test.tsx']],
    [
      'test-support',
      [
        'a/test-utils/y.ts',
        'a/src/testing/y.ts',
        'a/__tests__/y.ts',
        'a/fixtures/y.ts',
        'a/src/node-editor-test-utils.ts',
        'a/src/server/_test-helpers.ts',
        'a/src/server/_test-route-fuzz.ts',
      ],
    ],
    [
      'harness',
      ['a/startup.smoke-impl.ts', 'a/x.distribution-impl.ts', 'a/x.stress.ts', 'a/e2e/y.ts'],
    ],
    ['bench', ['a/src/layout.bench.ts', 'a/src/layout.bench.tsx']],
    ['docs-snapshot', ['apps/web/src/docs-snapshots/_helpers.ts', 'docs-snapshots/a.tsx']],
    [
      'shipped',
      ['a/src/lib.ts', 'a/src/testimonial.ts', 'a/src/contest.ts', 'a/src/test-case-runner.ts'],
    ],
  ]

  it.each(
    CASES.flatMap(([category, paths]) => paths.map((path) => [category, path] as const)),
  )('puts %s: %s', (category, path) => {
    expect(classifyPath(path)).toBe(category)
  })

  it('classifies a Windows separator the same as a posix one', () => {
    expect(classifyPath('a\\test-utils\\y.ts')).toBe('test-support')
  })

  it('keeps isTestPath to tests and their support, and isShippedPath to everything else', () => {
    expect(isTestPath('a/x.bench.ts')).toBe(false)
    expect(isShippedPath('a/x.bench.ts')).toBe(false)
    expect(isTestPath('a/_test-x.ts')).toBe(true)
    expect(isShippedPath('a/src/lib.ts')).toBe(true)
  })
})
