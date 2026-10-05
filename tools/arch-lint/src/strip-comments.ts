/**
 * Source text with every comment blanked, read off the TypeScript parser.
 *
 * The reference definition of "what is a comment" for a scan: a regex over
 * the text cannot tell a `//` that starts a comment from one inside
 * `'https://a.example'`, so it deletes code after a URL and mangles
 * `import.meta.glob('./**\/*.ts')`. Comments become spaces and keep their
 * newlines, so an offset into the result is an offset into the original.
 *
 * It is the PARSER and not `ts.createScanner` because a bare scanner has no
 * grammar to consult: it reads the text after a template's `${…}` as code, so
 * one interpolated template flips every later backtick, and it reads a quote
 * inside a regex literal as the start of a string. Both were measured
 * against this repo's own tests.
 *
 * `apps/web` and `mcp-server` cannot read this (a package does not import a
 * tool, and only this one holds the compiler API), so each carries a
 * dependency-free copy of the same contract in `test-utils/strip-comments.ts`;
 * `strip-comments-one-place.test.ts` holds those two identical and measures
 * them against this over every source file in the repo.
 */
import ts from '@typescript/typescript6'
import { parseSource } from './ast-helpers.js'

function commentStarts(sourceFile: ts.SourceFile): Map<number, number> {
  const text = sourceFile.text
  const ranges = new Map<number, number>()
  const visit = (node: ts.Node): void => {
    // A JSDoc block is a node of its own spanning exactly the comment, and the
    // only place one appears when nothing follows it in the file.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      if (node.kind === ts.SyntaxKind.JSDoc) ranges.set(node.pos, node.end)
      return
    }
    const children = node.getChildren(sourceFile)
    if (children.length > 0) {
      for (const child of children) visit(child)
      return
    }
    // A comment on the same line as the token before it is that token's
    // TRAILING trivia; every other comment is leading trivia of the next.
    const found = [
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.pos) ?? []),
    ]
    for (const range of found) ranges.set(range.pos, range.end)
  }
  visit(sourceFile)
  return ranges
}

/**
 * Several guards in one worker read the comments of the same files, and the parse is the cost;
 * keyed by name and text like `stripCommentsAndStrings`'s memo, so an edit between calls is a
 * miss rather than a stale answer. It keeps the key text and the offsets, never the tree: a kept
 * syntax tree is about twenty times its source, which across the whole repo is half a gigabyte
 * in every worker.
 */
const ranges = new Map<string, ReadonlyArray<readonly [number, number]>>()

/** Every comment in `raw` as `[start, end)` offsets, in source order, by the same reading. */
export function commentRanges(raw: string, fileName = 'source.tsx'): Array<[number, number]> {
  const key = `${fileName}\u0000${raw}`
  let found = ranges.get(key)
  if (found === undefined) {
    found = [...commentStarts(parseSource(fileName, raw, false))].sort((a, b) => a[0] - b[0])
    ranges.set(key, found)
  }
  return found.map(([start, end]) => [start, end])
}

export function stripComments(raw: string, fileName = 'source.tsx'): string {
  let out = ''
  let cursor = 0
  for (const [start, end] of commentRanges(raw, fileName)) {
    out += raw.slice(cursor, start) + raw.slice(start, end).replace(/[^\n]/g, ' ')
    cursor = end
  }
  return out + raw.slice(cursor)
}
