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
import { describe, expect, it } from 'vitest'
import { stripCommentsAndStrings } from './source-scan.js'

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
