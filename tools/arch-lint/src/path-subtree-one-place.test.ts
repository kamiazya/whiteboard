/**
 * "Is this path at or under that one" and "where does it land when that one
 * moves" are answered in `packages/model/src/document-path.ts`, and nowhere
 * else.
 *
 * The rule is a SEGMENT boundary, so `design-system` is not inside `design`.
 * Hand-spelling it as `path.startsWith(`${root}/`)` and re-rooting with
 * `${to}${path.slice(from.length)}` produced thirteen copies, and a store that
 * re-derived it once stranded a folder's children while its sibling moved
 * them. `history` and `codec` cannot import `ports`, which is why the owner
 * sits in `model`.
 *
 * Three shapes are read from the syntax tree, never a text pattern on the name,
 * so a line break, an alias or a nested call cannot walk past:
 * - a `.startsWith(` call whose argument is a template literal ending in `/`;
 * - a template holding a substitution directly followed by `<x>.slice(<y>.length)`,
 *   or the same joined with `+`, which is the root being swapped for another;
 * - the same two once the `…/` prefix is bound to a name first
 *   (`const prefix = folder === '' ? '' : `${folder}/``), so naming the
 *   prefix does not walk past: `.startsWith(prefix)` and `<x>.slice(prefix.length)`.
 *   The binding is read by name within the file, not by scope, which can
 *   only over-count a same-named binding that is not a prefix.
 *
 * Tests and `test-utils` are out of scope: a fake keeper restating the rule is
 * how a test proves the real one.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource } from './ast-helpers.js'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

const OWNER = 'packages/model/src/document-path.ts'

/** Sites that state the rule by hand on purpose, each with why it cannot use the owner. */
const LEFT_IN_PLACE: Readonly<Record<string, string>> = {}

const isLengthOf = (node: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(node) && node.name.text === 'length'

/** `<x>.slice(<y>.length)`: the tail left once a prefix of that length is dropped. */
function isSliceOffPrefix(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'slice' &&
    node.arguments.length === 1 &&
    isLengthOf(node.arguments[0] as ts.Expression)
  )
}

/** An expression that yields a `…/` template, however it is parenthesised or guarded. */
function yieldsSlashTemplate(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return yieldsSlashTemplate(node.expression)
  }
  if (ts.isConditionalExpression(node)) {
    return yieldsSlashTemplate(node.whenTrue) || yieldsSlashTemplate(node.whenFalse)
  }
  return (
    ts.isTemplateExpression(node) &&
    node.templateSpans[node.templateSpans.length - 1]?.literal.text.endsWith('/') === true
  )
}

/** Names the file binds to a `…/` prefix, whose later use is the same rule as the inline template. */
function slashPrefixNames(file: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      yieldsSlashTemplate(node.initializer)
    ) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}

/** `<x>.slice(<prefix>.length)` where `<prefix>` is a name bound to a `…/` template. */
function isSliceOffBoundPrefix(node: ts.Node, prefixes: ReadonlySet<string>): boolean {
  if (!ts.isCallExpression(node) || !isSliceOffPrefix(node)) return false
  const length = node.arguments[0] as ts.PropertyAccessExpression
  return ts.isIdentifier(length.expression) && prefixes.has(length.expression.text)
}

/** How many hand-spelled subtree tests and re-roots `source` holds. */
function countPathSubtreeSpellings(fileName: string, source: string): number {
  const file = parseSource(fileName, source)
  const prefixes = slashPrefixNames(file)
  let found = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'startsWith'
    ) {
      const [argument] = node.arguments
      if (
        argument !== undefined &&
        (ts.isTemplateExpression(argument)
          ? yieldsSlashTemplate(argument)
          : ts.isIdentifier(argument) && prefixes.has(argument.text))
      ) {
        found += 1
      }
    } else if (isSliceOffBoundPrefix(node, prefixes)) {
      found += 1
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      isSliceOffPrefix(node.right)
    ) {
      found += 1
    } else if (ts.isTemplateExpression(node)) {
      node.templateSpans.forEach((span, index) => {
        const before =
          index === 0 ? node.head.text : (node.templateSpans[index - 1]?.literal.text ?? '')
        if (before === '' && isSliceOffPrefix(span.expression)) found += 1
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const files: string[] = []
for (const root of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, root), files)
const shipped = files
  .filter((path) => isShippedPath(path))
  .map((path) => ({ path, rel: relative(REPO_ROOT, path).split(sep).join('/') }))
  .filter(({ rel }) => rel.startsWith('packages/') || rel.startsWith('apps/'))

/** A fixture writes `@{x}` for a substitution, so no fixture reads as a template placeholder. */
const source = (text: string): string => text.replaceAll('@{', '$\u007b')

const FIXTURES: readonly { readonly source: string; readonly spellings: number }[] = [
  { source: 'path.startsWith(`@{root}/`)', spellings: 1 },
  { source: 'path === root || path.startsWith(`@{root}/`)', spellings: 1 },
  { source: 'key.startsWith(`@{workspaceId}/@{path}/`)', spellings: 1 },
  { source: 'row.path\n  .startsWith(\n    `@{from}/`,\n  )', spellings: 1 },
  { source: 'const next = `@{to}@{path.slice(from.length)}`', spellings: 1 },
  { source: 'const next = `@{to}@{path.slice(prefix.length)}`', spellings: 1 },
  { source: 'const next = to + path.slice(from.length)', spellings: 1 },
  { source: 'const next = path.slice(from.length) + suffix', spellings: 0 },
  {
    source: 'path.startsWith(`@{root}/`) ? `@{to}@{path.slice(root.length)}` : path',
    spellings: 2,
  },
  { source: 'path.startsWith("design/")', spellings: 0 },
  { source: 'path.startsWith(`design/`)', spellings: 0 },
  { source: 'path.startsWith(`@{root}-`)', spellings: 0 },
  { source: 'path.startsWith(`@{root}/x`)', spellings: 0 },
  { source: 'const label = `@{kind}: @{name.slice(0, 8)}`', spellings: 0 },
  { source: 'const rest = `@{to}/@{path.slice(from.length)}`', spellings: 0 },
  {
    source:
      "const prefix = folder === '' ? '' : `@{folder}/`\nconst rest = paths.filter((p) => p.startsWith(prefix))",
    spellings: 1,
  },
  { source: 'const prefix = `@{folder}/`\nconst rest = path.slice(prefix.length)', spellings: 1 },
  {
    source: "const prefix = folder === '' ? '' : `@{folder}/`\nreturn `@{prefix}@{name}`",
    spellings: 0,
  },
  { source: 'const prefix = `@{folder}-`\nconst hit = path.startsWith(prefix)', spellings: 0 },
  { source: 'const hit = path.startsWith(prefix)', spellings: 0 },
  { source: 'const rest = path.slice(prefix.length)', spellings: 0 },
  { source: '// path.startsWith(`@{root}/`)', spellings: 0 },
  { source: "log.warn('path.startsWith(`@{root}/`)')", spellings: 0 },
]

describe('a path subtree is judged and re-rooted in one place', () => {
  it('recognises each spelling, and not a lookalike or a mention', () => {
    for (const { source: text, spellings } of FIXTURES) {
      expect(countPathSubtreeSpellings('fixture.ts', source(text)), text).toBe(spellings)
    }
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(shipped.length).toBeGreaterThan(1000)
    expect(shipped.some(({ rel }) => rel === OWNER)).toBe(true)
    expect(
      countPathSubtreeSpellings(OWNER, readFileSync(join(REPO_ROOT, OWNER), 'utf8')),
    ).toBeGreaterThan(0)
  })

  const outside = shipped
    .filter(({ rel }) => rel !== OWNER)
    .map(({ path, rel }) => ({
      rel,
      spellings: countPathSubtreeSpellings(path, readFileSync(path, 'utf8')),
    }))
    .filter(({ spellings }) => spellings > 0)

  it('has no hand-spelled copy outside the owner beyond the ones left in place', () => {
    expect(
      outside.map(({ rel }) => rel).filter((rel) => !(rel in LEFT_IN_PLACE)),
      'use `isSelfOrDescendant` / `rebasePath` from `@kamiazya/whiteboard-model`, so the segment rule has one definition',
    ).toEqual([])
  })

  it('lists only files that still hold a copy', () => {
    // An entry that no longer spells the rule is a standing permission for the
    // next copy, and nothing else would notice it had outlived its reason.
    const holding = new Set(outside.map(({ rel }) => rel))
    expect(Object.keys(LEFT_IN_PLACE).filter((rel) => !holding.has(rel))).toEqual([])
  })
})
