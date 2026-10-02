/**
 * What counts as an auth marker the redactor left behind is defined in ONE
 * place, `redact.ts`'s `scrubAuthMarkers`, and this is the executable half.
 *
 * Why a scan. `redactDiagnosticText` keeps the `Bearer [REDACTED]` marker on
 * purpose, and the surfaces that want no `Bearer` / `Authorization` keyword at
 * all strip it afterwards. The stdio error path of the CLI dispatcher
 * re-spelled both regexes beside a call to the same redactor, under a comment
 * about why it needed a second pass — while `redact.ts` says it is "one
 * definition, so the two surfaces cannot disagree". A third copy that edits
 * one pattern and not the others disagrees silently, and a leak through the
 * marker reads as redacted.
 *
 * The scan reads the AST, so a comment or a string that merely PRINTS
 * `[REDACTED]` (the redactor's own output) is not a hit. What is: a regex
 * literal naming the marker as `\[REDACTED\]`, or `RegExp('…REDACTED…')`.
 *
 * Both-sided: an allowlisted file that stopped matching fails as stale.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const REDACTOR = 'packages/mcp-server/src/shared/diagnostics/redact.ts'

const ESCAPED_MARKER = /\\\[REDACTED/

function respellsMarker(source: string, name = 'source.ts'): boolean {
  // Most files never mention the word; skip parsing them.
  if (!source.includes('REDACTED')) return false
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true)
  const names = (node: ts.Node): boolean => {
    if (ts.isRegularExpressionLiteral(node)) return ESCAPED_MARKER.test(node.text)
    if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
      const [first] = node.arguments ?? []
      return (
        node.expression.getText(file) === 'RegExp' &&
        first !== undefined &&
        ts.isStringLiteralLike(first) &&
        first.text.includes('REDACTED')
      )
    }
    return false
  }
  const search = (node: ts.Node): boolean => names(node) || ts.forEachChild(node, search) === true
  return search(file)
}

/** Relative path -> why it may spell the marker. Both-sided. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  [REDACTOR]: 'the one definition: scrubAuthMarkers and the patterns behind it',
}

const files = [
  ...walkSourceFiles(join(REPO_ROOT, 'packages')),
  ...walkSourceFiles(join(REPO_ROOT, 'apps')),
].filter((path) => !isTestPath(path))
const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const spellers = files.filter((path) => respellsMarker(readFileSync(path, 'utf8'), path)).map(relOf)

describe('an auth marker is recognised in one place', () => {
  it('reads a tree worth reading, redactor included', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files.map(relOf)).toContain(REDACTOR)
  })

  it('recognises the shapes a re-spelling takes', () => {
    expect(respellsMarker('text.replace(/Bearer\\s*\\[REDACTED\\]/gi, "x")')).toBe(true)
    expect(respellsMarker('x.replace(/Authorization\\s*:\\s*\\[REDACTED\\]/gi, "y")')).toBe(true)
    expect(respellsMarker("new RegExp('Bearer\\\\s*REDACTED', 'gi')")).toBe(true)
    expect(respellsMarker("const printed = 'Bearer [REDACTED]'")).toBe(false)
    expect(respellsMarker('// the /\\[REDACTED\\]/ marker')).toBe(false)
  })

  it('no file outside the redactor re-spells the marker', () => {
    const outside = spellers.filter((rel) => ALLOWLIST[rel] === undefined)
    expect(
      outside,
      'import `scrubAuthMarkers` from shared/diagnostics/redact.ts instead of writing the patterns again',
    ).toEqual([])
  })

  it('has no allowlist entry for a file that stopped spelling it', () => {
    const stale = Object.keys(ALLOWLIST).filter((rel) => !spellers.includes(rel))
    expect(stale, 'delete the entry').toEqual([])
  })
})
