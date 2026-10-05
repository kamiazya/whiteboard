/**
 * The sync wire's doc key is spelled in ONE place, and this scan is the
 * executable half of that.
 *
 * A page follows a workspace's record as `workspace:<id>` and a document as
 * `<handle>/<path>`; `sse-stream-hub.ts` in daemon-client builds and parses
 * both (`workspaceDocKey` and `documentSyncKey` build, the `*OfSyncKey`
 * functions parse). That grammar is not the STORED key (`workspace-tree:<id>`, ports'
 * `docRefKey` — see `doc-ref-key-one-place.test.ts`): the two answer
 * different questions and a reader holding the wrong parser fails open, so a
 * second hand spelling of the wire prefix is a parser that agrees with
 * itself.
 *
 * The prefix constant is deliberately not exported, so a consumer cannot
 * reach it at all; what this scan finds is the literal spelled by hand. The
 * per-document half has no prefix to hide, so it is found by its join: a
 * string that is exactly a workspace handle, a slash and a path. Both are read
 * from the syntax tree, because a template, a `+` chain and `[…].join()` build
 * the same key and a text pattern for one passes the other two.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource, unwrapExpression } from './ast-helpers.js'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { walkSourceFiles } from './source-scan.js'

/** Where the one spelling lives. Exempt by construction: it IS the place. */
const DECLARATION_SITE = 'packages/daemon-client/src/sse-stream-hub.ts'

/**
 * One piece of a string built by hand: text the code wrote, or a hole whose
 * source text is kept so its NAME can be judged.
 */
type Part = { literal: string } | { hole: string }

const literalPart = (literal: string): Part => ({ literal })

/** Adjacent text merged, so `'workspace'` + `':'` reads as `workspace:`. */
function merged(parts: readonly Part[]): Part[] {
  const out: Part[] = []
  for (const part of parts) {
    const last = out.at(-1)
    if (last !== undefined && 'literal' in last && 'literal' in part) {
      out[out.length - 1] = literalPart(last.literal + part.literal)
    } else if (!('literal' in part && part.literal === '')) {
      out.push(part)
    }
  }
  return out
}

const constStringsByFile = new WeakMap<ts.SourceFile, ReadonlyMap<string, string>>()

/**
 * Every `const NAME = '…'` in a file, so a piece held in a constant reads as
 * the text it holds: `const WS = 'workspace'` then `[WS, id].join(':')` is the
 * prefix spelled by hand one rename away. A name declared with two different
 * texts is dropped rather than guessed at.
 */
function constStrings(file: ts.SourceFile): ReadonlyMap<string, string> {
  const cached = constStringsByFile.get(file)
  if (cached !== undefined) return cached
  const found = new Map<string, string | null>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) {
        const init = declaration.initializer && unwrapExpression(declaration.initializer)
        if (!ts.isIdentifier(declaration.name) || init === undefined) continue
        if (!ts.isStringLiteralLike(init)) continue
        const seen = found.get(declaration.name.text)
        found.set(
          declaration.name.text,
          seen === undefined || seen === init.text ? init.text : null,
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  const strings = new Map<string, string>()
  for (const [name, text] of found) if (text !== null) strings.set(name, text)
  constStringsByFile.set(file, strings)
  return strings
}

/**
 * The pieces a string-building expression is made of, whichever way it is
 * spelled: a template, a `+` chain, or `[a, b].join('/')`. The three are one
 * key written three ways, and a scan of one spelling passes the others.
 */
function partsOf(file: ts.SourceFile, raw: ts.Expression): Part[] {
  const node = unwrapExpression(raw)
  if (ts.isStringLiteralLike(node)) return [literalPart(node.text)]
  if (ts.isIdentifier(node)) {
    const held = constStrings(file).get(node.text)
    if (held !== undefined) return [literalPart(held)]
  }
  if (ts.isTemplateExpression(node)) {
    return merged([
      literalPart(node.head.text),
      ...node.templateSpans.flatMap((span) => [
        ...partsOf(file, span.expression),
        literalPart(span.literal.text),
      ]),
    ])
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return merged([...partsOf(file, node.left), ...partsOf(file, node.right)])
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'join' &&
    ts.isArrayLiteralExpression(unwrapExpression(node.expression.expression))
  ) {
    const [separator] = node.arguments
    const array = unwrapExpression(node.expression.expression) as ts.ArrayLiteralExpression
    if (separator !== undefined && ts.isStringLiteralLike(separator)) {
      return merged(
        array.elements.flatMap((element, index) => [
          ...(index === 0 ? [] : [literalPart(separator.text)]),
          ...partsOf(file, element),
        ]),
      )
    }
  }
  return [{ hole: node.getText(file) }]
}

const WORKSPACE_PREFIX = 'workspace:'
// `ws` and `wsId` only as a whole name or a camel-cased word, so `views` and
// `rows` are not handles.
const HANDLE_NAME = /^(?:[\w.]*(?:[wW]orkspace(?:Id)?|[hH]andle|Ws(?:Id)?)|(?:[\w.]*\.)?ws(?:Id)?)$/
const PATH_NAME = /^[\w.]*[pP]ath$/

/**
 * The wire prefix spelled by hand: the prefix as a whole string (a
 * `startsWith`, a `slice('…'.length)`, a constant), as the head of a string
 * with a hole after it (template, concat or join), a regex literal, or the
 * constant's identifier. A `workspace:read` is an auth scope, not this key, so
 * the text must end right after the colon.
 */
function isWireSpelling(file: ts.SourceFile, node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === 'WORKSPACE_DOC_KEY_PREFIX'
  if (ts.isRegularExpressionLiteral(node)) return /\^?workspace:/.test(node.text)
  if (ts.isStringLiteralLike(node)) return /^\^?workspace:$/.test(node.text)
  if (!isKeyBuilder(node)) return false
  const [first, second] = partsOf(file, node as ts.Expression)
  return (
    first !== undefined &&
    'literal' in first &&
    first.literal === WORKSPACE_PREFIX &&
    second !== undefined &&
    'hole' in second
  )
}

/**
 * The per-document key spelled by hand: a whole string that is exactly
 * `<…workspaceId or …handle>/<…path>`. Being nothing else is what separates a
 * key from a message that merely names a document
 * (`Document "${workspaceId}/${path}" already exists`) or a longer URL.
 */
function isDocumentKeyJoin(file: ts.SourceFile, node: ts.Node): boolean {
  if (!isKeyBuilder(node)) return false
  const parts = partsOf(file, node as ts.Expression)
  const [id, slash, path] = parts
  return (
    parts.length === 3 &&
    id !== undefined &&
    'hole' in id &&
    HANDLE_NAME.test(id.hole) &&
    slash !== undefined &&
    'literal' in slash &&
    slash.literal === '/' &&
    path !== undefined &&
    'hole' in path &&
    PATH_NAME.test(path.hole)
  )
}

/**
 * A string-building expression, judged at its outermost node: the inner `+` of
 * `a + '/' + b` is a piece of the key, not a second one.
 */
function isKeyBuilder(node: ts.Node): boolean {
  if (ts.isTemplateExpression(node)) return true
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return !(
      ts.isBinaryExpression(node.parent) &&
      node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
    )
  }
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'join'
  )
}

function countMatches(
  source: string,
  matches: (file: ts.SourceFile, node: ts.Node) => boolean,
  fileName: string,
): number {
  const file = parseSource(fileName, source)
  let count = 0
  const visit = (node: ts.Node): void => {
    if (matches(file, node)) count++
    ts.forEachChild(node, visit)
  }
  visit(file)
  return count
}

/**
 * Files that join a handle and a path into a key of their own, one that is
 * never parsed by `workspaceHandleOfSyncKey` and never leaves the process.
 * `history` cannot import daemon-client, and the scheduler's map key is
 * private to it.
 */
const PRIVATE_DOCUMENT_KEYS = new Set(['packages/history/src/checkpoints/scheduler.ts'])

function spellings(source: string, fileName = 'p.ts'): number {
  return countMatches(source, isWireSpelling, fileName)
}

function documentJoins(source: string, fileName = 'p.ts'): number {
  return countMatches(source, isDocumentKeyJoin, fileName)
}

const files = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root))).filter(
  (path) => !/\.(test|spec)\.tsx?$/.test(path) && !isExcludedPath(path),
)

const HOLE = ['$', '{id}'].join('')

describe('the sync wire doc key is spelled in one place', () => {
  it('recognises a template, a quoted prefix, a regex and the constant, and passes scopes and prose through', () => {
    expect(spellings(`const k = \`workspace:${HOLE}\``)).toBe(1)
    expect(spellings("if (key.startsWith('workspace:')) return")).toBe(1)
    expect(spellings("const id = key.slice('workspace:'.length)")).toBe(1)
    expect(spellings('const m = /^workspace:(.+)$/.exec(key)')).toBe(1)
    expect(spellings('if (key.startsWith(WORKSPACE_DOC_KEY_PREFIX)) return')).toBe(1)
    expect(spellings("const scope = 'workspace:read'")).toBe(0)
    expect(spellings(`// \`workspace:${HOLE}\` in a comment`)).toBe(0)
    expect(spellings(`/**\n * a \`workspace:\` key in a doc block\n */`)).toBe(0)
    expect(spellings('if (key.startsWith(`workspace:`)) return')).toBe(1)
    expect(spellings(`const k = \`workspaces:${HOLE}\``)).toBe(0)
  })

  it('recognises the wire prefix built by concatenation or join, and passes scopes through', () => {
    expect(spellings("const k = 'workspace:' + id")).toBeGreaterThan(0)
    expect(spellings("const k = ['workspace', id].join(':')")).toBe(1)
    expect(spellings("const k = ('workspace' + ':' + id) as string")).toBe(1)
    expect(spellings("const k = ['workspace', 'read'].join(':')")).toBe(0)
    expect(spellings("const k = 'workspace:read:' + id")).toBe(0)
    expect(spellings(`const k = \`workspace:read:${HOLE}\``)).toBe(0)
  })

  it('reads a constant holding part of the prefix as the text it holds', () => {
    expect(spellings("const WS = 'workspace'\nconst k = [WS, id].join(':')")).toBe(1)
    expect(spellings("const WS = 'workspace'\nconst k = WS + ':' + id")).toBe(1)
    expect(spellings("const SEP = ':'\nconst k = 'workspace' + SEP + id")).toBe(1)
    expect(spellings("const WS = 'workspace'\nconst k = [WS, 'read'].join(':')")).toBe(0)
    // A name the file gives two texts is not guessed at.
    expect(
      spellings("{ const WS = 'tab' }\n{ const WS = 'workspace' }\nconst k = WS + ':' + id"),
    ).toBe(0)
  })

  it('recognises a handle-and-path join under every name in use, and passes messages and URLs through', () => {
    const hole = (name: string) => ['$', `{${name}}`].join('')
    const join = (a: string, b: string) => `${hole(a)}/${hole(b)}`
    expect(documentJoins(`const k = \`${join('workspaceId', 'path')}\``)).toBe(1)
    expect(documentJoins(`const k = \`${join('handle', 'path')}\``)).toBe(1)
    expect(documentJoins(`const k = \`${join('canvas.workspaceId', 'canvas.path')}\``)).toBe(1)
    expect(documentJoins(`key = \`${join('this.workspaceId', 'documentPath')}\``)).toBe(1)
    expect(documentJoins(`const k = \`${join('ws', 'docPath')}\``)).toBe(1)
    expect(documentJoins(`const k = \`${join('target.wsId', 'path')}\``)).toBe(1)
    expect(documentJoins(`const k = \`${join('workspace', 'path')}\``)).toBe(1)
    expect(documentJoins(`const k = \`${join('views', 'path')}\``)).toBe(0)
    expect(documentJoins(`const k = \`${join('rows', 'path')}\``)).toBe(0)
    expect(
      documentJoins(`throw new Error(\`Document "${join('workspaceId', 'path')}" exists\`)`),
    ).toBe(0)
    expect(documentJoins(`const url = \`${join('base', 'path')}\``)).toBe(0)
    expect(documentJoins(`const url = \`/api/w/${join('workspaceId', 'path')}\``)).toBe(0)
    expect(documentJoins(`// \`${join('workspaceId', 'path')}\` in a comment`)).toBe(0)
  })

  it('recognises a handle-and-path key built by concatenation or join', () => {
    expect(documentJoins("const k = workspaceId + '/' + path")).toBe(1)
    expect(documentJoins("const k = (handle + '/' + docPath) as string")).toBe(1)
    expect(documentJoins("const k = [workspaceId, path].join('/')")).toBe(1)
    expect(documentJoins("const k = [canvas.workspaceId, canvas.path].join('/')")).toBe(1)
    expect(documentJoins("const url = base + '/' + path")).toBe(0)
    expect(documentJoins("const k = [workspaceId, path].join(', ')")).toBe(0)
    expect(documentJoins("const m = 'Document ' + workspaceId + '/' + path + ' exists'")).toBe(0)
    expect(documentJoins("const k = workspaceId + '/api/' + path")).toBe(0)
  })

  it('scans a tree worth scanning', () => {
    expect(files.length).toBeGreaterThan(800)
  })

  it('no file outside the declaration site spells the wire prefix', () => {
    const hits: string[] = []
    for (const path of files) {
      const rel = relativeToRepo(path)
      if (rel === DECLARATION_SITE) continue
      const found = spellings(readFileSync(path, 'utf8'), path)
      if (found > 0) hits.push(`${rel}: ${found}`)
    }
    expect(hits).toEqual([])
  })

  it('no file outside the declaration site joins a handle and a path into a key by hand', () => {
    const hits: string[] = []
    for (const path of files) {
      const rel = relativeToRepo(path)
      if (rel === DECLARATION_SITE || PRIVATE_DOCUMENT_KEYS.has(rel)) continue
      const found = documentJoins(readFileSync(path, 'utf8'), path)
      if (found > 0) hits.push(`${rel}: ${found}`)
    }
    expect(hits).toEqual([])
  })

  it('the private-key exemptions still join one, and the declaration site joins exactly once', () => {
    // An exemption whose file stopped spelling the join is a stale entry; a
    // declaration site at zero would mean the builder moved.
    for (const rel of PRIVATE_DOCUMENT_KEYS) {
      expect(documentJoins(readFileSync(join(REPO_ROOT, rel), 'utf8'), rel)).toBeGreaterThan(0)
    }
    expect(
      documentJoins(readFileSync(join(REPO_ROOT, DECLARATION_SITE), 'utf8'), DECLARATION_SITE),
    ).toBe(1)
  })

  it('the declaration site spells it exactly as often as the grammar needs', () => {
    // The constant's declaration counts twice (identifier and literal), the
    // builder twice (the identifier, and the template that reads through it to
    // the prefix), then `workspaceIdOfSyncKey` (two) and
    // `workspaceHandleOfSyncKey`. A count that fell to zero would mean the
    // grammar moved and this scan guards a file that no longer holds it.
    expect(
      spellings(readFileSync(join(REPO_ROOT, DECLARATION_SITE), 'utf8'), DECLARATION_SITE),
    ).toBe(7)
  })
})
