/**
 * A daemon-package test finds the repo root through `repoRoot()`, never by
 * counting `../` from its own location.
 *
 * A count is right for exactly one depth. Moving a test one directory
 * changes it, and what happens next depends on the test: one that reads a
 * named file fails loudly, but one that WALKS a tree scans the wrong one and
 * can pass — measured by dropping or adding one segment in each, two of them
 * (`legacy-ui-retired`, whose directory read answers `[]` on failure, and
 * `verify-git-hooks`, which skips when its hooks directory is absent) stayed
 * green over a tree they were not looking at. The helper walks up from its
 * own directory to the nearest `pnpm-workspace.yaml`, which is the one place
 * a checkout, a worktree and a nested worktree each say where they begin.
 *
 * The check is semantic rather than a list of spellings: a path literal made
 * of leading `..` segments is resolved from the test's own directory and
 * reported when it lands on the repo root, whatever the variable is called
 * and whether it is joined, resolved or handed to `new URL`. A sibling path
 * such as `../../../scripts/x.mjs` reaches the package, not the root, and
 * stays out.
 *
 * arch-lint cannot import the helper (tools read packages, packages do not
 * import tools), so `scan-roots.ts` keeps the one fixed count a tool needs.
 *
 * Comments are blanked before any matcher runs: a comment that spells the old
 * count as an example is prose about a derivation, not one. The blanking keeps
 * every offset and line break, so the module-specifier check still sees what
 * precedes a literal.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, relativeToRepo, walk } from './scan-roots.js'

const SCANNED_TREES = ['packages/mcp-server/src', 'packages/mcp-server/scripts']

// A literal that starts with `..` segments, optionally followed by a path, in
// any of the three quotes: '../../../..', "../../../../", `../../../../tools/x.mjs`.
const DOTDOT_LITERAL = /['"`]((?:\.\.\/)*\.\.)(?:\/[^'"`]*)?['"`]/g
// The same count spelled as arguments: resolve(dir, '..', '..', '..').
const DOTDOT_ARGUMENTS = /(?:['"]\.\.['"]\s*,\s*)+['"]\.\.['"]/g
// A module specifier is resolved by the loader from the importing file, so a
// moved file fails to compile instead of scanning another tree.
const MODULE_SPECIFIER_BEFORE = /(?:\bfrom|\bimport\s*\(?|\bvi\.(?:do)?[mM]ock\()\s*$/

// Package root first, then up two: the other way to spell the repo root.
const PACKAGE_ROOT_TWO_UP = /\b(?:packageRoot|PACKAGE_ROOT)\b\s*,\s*['"]\.\.\/\.\.['"]/

function upFrom(dir: string, segments: number): string {
  return resolve(dir, ...Array.from({ length: segments }, () => '..'))
}

/** `raw` with every comment blanked to spaces: same length, same line breaks. */
function withoutComments(raw: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, raw)
  let out = raw
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue
    }
    const start = scanner.getTokenStart()
    const end = scanner.getTokenEnd()
    out = out.slice(0, start) + raw.slice(start, end).replace(/[^\n]/g, ' ') + out.slice(end)
  }
  return out
}

/** The `../` counts in `raw` that land on `root` when taken from `fileDir`. */
function rootDerivations(raw: string, fileDir: string, root: string): string[] {
  const source = withoutComments(raw)
  const found: string[] = []
  for (const match of source.matchAll(DOTDOT_LITERAL)) {
    if (MODULE_SPECIFIER_BEFORE.test(source.slice(0, match.index))) continue
    const segments = (match[1] ?? '').split('/').length
    if (upFrom(fileDir, segments) === root) found.push(match[0])
  }
  for (const match of source.matchAll(DOTDOT_ARGUMENTS)) {
    const segments = match[0].split(',').length
    if (upFrom(fileDir, segments) === root) found.push(match[0])
  }
  const packageRootForm = PACKAGE_ROOT_TWO_UP.exec(source)
  if (packageRootForm !== null) found.push(packageRootForm[0])
  return found
}

function testFiles(): string[] {
  return SCANNED_TREES.flatMap((tree) =>
    walk(join(REPO_ROOT, tree), {
      include: (path) => path.endsWith('.test.ts'),
      skip: (_path, name) => name === 'node_modules',
    }),
  )
}

describe('rootDerivations (self-test)', () => {
  const release = join(REPO_ROOT, 'packages/mcp-server/src/server/release')
  const server = join(REPO_ROOT, 'packages/mcp-server/src/server')

  it('reports each spelling of a count that lands on the repo root', () => {
    expect(
      rootDerivations("resolve(__dirname, '../../../../..')", release, REPO_ROOT),
    ).toHaveLength(1)
    expect(rootDerivations("join(import.meta.dirname, '../../../../')", server, REPO_ROOT)).toEqual(
      ["'../../../../'"],
    )
    expect(
      rootDerivations("resolve(__dirname, '..', '..', '..', '..', '..')", release, REPO_ROOT),
    ).toHaveLength(1)
    expect(
      rootDerivations("new URL('../../../../../', import.meta.url)", release, REPO_ROOT),
    ).toHaveLength(1)
    expect(
      rootDerivations("join(__dirname, '../../../../tools/check.mjs')", server, REPO_ROOT),
    ).toHaveLength(1)
    expect(rootDerivations("resolve(packageRoot, '../..')", release, REPO_ROOT)).toHaveLength(1)
    expect(
      rootDerivations('resolve(import.meta.dirname, `../../../../`)', server, REPO_ROOT),
    ).toEqual(['`../../../../`'])
  })

  it('leaves a count that only a comment spells alone', () => {
    expect(
      rootDerivations(
        "// was resolve(__dirname, '../../../..')\nconst r = repoRoot()",
        server,
        REPO_ROOT,
      ),
    ).toEqual([])
    expect(
      rootDerivations(
        "/* resolve(__dirname, '..', '..', '..', '..') */ repoRoot()",
        server,
        REPO_ROOT,
      ),
    ).toEqual([])
    // A blanked comment keeps its length, so the specifier check still sees `from`.
    expect(
      rootDerivations("/* note */ import x from '../../../../vitest.shared.js'", server, REPO_ROOT),
    ).toEqual([])
  })

  it('leaves a path that reaches the package or a sibling in the tree alone', () => {
    expect(rootDerivations("join(__dirname, '../../../package.json')", release, REPO_ROOT)).toEqual(
      [],
    )
    expect(rootDerivations("'../../store/document-store.js'", release, REPO_ROOT)).toEqual([])
    expect(rootDerivations("'../../../../daemon-client/src/x.ts'", release, REPO_ROOT)).toEqual([])
    expect(rootDerivations("resolve(dir, '..')", release, REPO_ROOT)).toEqual([])
    expect(
      rootDerivations("} from '../../../../../vitest.browser.shared.js'", release, REPO_ROOT),
    ).toEqual([])
  })

  it('takes the depth from where the file is, not from the spelling', () => {
    expect(rootDerivations("'../../../..'", release, REPO_ROOT)).toEqual([])
    expect(rootDerivations("'../../../..'", dirname(server), REPO_ROOT)).toEqual([])
    expect(rootDerivations("'../../../..'", server, REPO_ROOT)).toEqual(["'../../../..'"])
  })
})

describe('daemon-package tests find the repo root through the helper', () => {
  it('reads a population of test files, so a scan that matches nothing cannot pass', () => {
    expect(testFiles().length).toBeGreaterThan(300)
  })

  it('has no test counting ../ to the repo root', () => {
    const offenders = testFiles().flatMap((file) => {
      const found = rootDerivations(readSource(file), dirname(file), REPO_ROOT)
      return found.length === 0 ? [] : [`${relativeToRepo(file)}: ${found.join(' ')}`]
    })
    expect(offenders, 'use repoRoot() from shared/test-utils/repo-root.ts').toEqual([])
  })
})

function readSource(file: string): string {
  return readFileSync(file, 'utf8')
}
