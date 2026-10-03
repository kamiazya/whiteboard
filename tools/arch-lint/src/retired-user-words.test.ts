/**
 * Nouns the product retired, kept out of what a USER reads.
 *
 * ADR-0029 retired the branch (a Version is a saved point, never a branch)
 * and the variation and merge that came with it; thumbnails were removed from
 * versions. A user-facing sentence naming one reads as a second thing they
 * might lose, or as a bug — a destructive confirmation said "Its versions and
 * branches are deleted" long after the feature was gone, because the
 * vocabulary rule is prose and a retired word in a string reaches nobody's
 * grep. `vocabulary-check.test.ts` keeps identifiers and comments honest;
 * this is its sibling for text a person reads.
 *
 * Read from the syntax tree, not the file text, so a comment explaining why
 * the word is gone is not a use of it. Only prose is judged: a literal that
 * is a lowercase token (`'document-thumbnail'`, an import path, a test id)
 * names code, and the component and surface it names are alive.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, relativeToRepo } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

/**
 * Each retired noun with a sentence it exists to catch. The example is the
 * other side of the table: a pattern that stops matching its own example has
 * been broken, and the scan below would then pass on everything.
 */
const RETIRED_USER_WORDS = [
  {
    word: 'branches',
    pattern: /\bbranch(?:es)?\b/i,
    example: 'Its versions and branches are deleted.',
  },
  { word: 'variations', pattern: /\bvariations?\b/i, example: 'Switch variation' },
  {
    word: 'combining changes',
    pattern: /\bcombin(?:e|es|ing)\s+(?:the\s+)?changes\b/i,
    example: 'Combining changes from another copy',
  },
  {
    // The merge of a variation back into its parent. A workspace transfer is
    // still a CRDT merge (ADR-0023) and says so, so the bare word is not retired.
    word: 'merge (variation sense)',
    pattern: /\bmerg(?:e|es|ed|ing)\s+(?:this\s+|the\s+|a\s+)?(?:variation|branch|changes)\b/i,
    example: 'Merge this variation into main',
  },
  { word: 'thumbnail', pattern: /\bthumbnails?\b/i, example: 'Attach a thumbnail to this version' },
] as const

/** A lowercase token: an identifier, path, test id or class list rather than a sentence. */
const CODE_TOKEN = /^[a-z0-9][a-z0-9_./:@#-]*$/

function proseLiterals(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isJsxText(node)
    ) {
      const text = node.text.replace(/\s+/g, ' ').trim()
      if (text !== '' && !CODE_TOKEN.test(text)) found.push(text)
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // A piece beside a substitution is prose when it is spaced off from it;
      // `${base}-thumbnail` is a name being built, ` variations` is a sentence.
      if (/\s/.test(node.text)) found.push(node.text.replace(/\s+/g, ' ').trim())
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function retiredWordsIn(fileName: string, source: string): string[] {
  const literals = proseLiterals(fileName, source)
  return RETIRED_USER_WORDS.filter(({ pattern }) =>
    literals.some((text) => pattern.test(text)),
  ).map(({ word }) => word)
}

/** Shipped source only: a test's titles and fixtures may name the retired word to prove it is gone. */
function isShipped(path: string): boolean {
  // `.contract.` suites are shared test suites that are not test-named, hence the extra clause.
  return isShippedPath(path) && !/\.contract\.tsx?$/.test(path)
}

describe('retired nouns stay out of user-facing strings', () => {
  it.each(RETIRED_USER_WORDS)('the table catches its own example: $word', ({ word, example }) => {
    expect(
      retiredWordsIn('fixture.ts', `export const copy = ${JSON.stringify(example)}`),
    ).toContain(word)
  })

  it('reads string, template and JSX text, and passes comments and code tokens by', () => {
    expect(retiredWordsIn('a.ts', "const a = 'Its branches are gone'")).toEqual(['branches'])
    expect(retiredWordsIn('a.ts', ['const a = `Its $', '{n} variations`'].join(''))).toEqual([
      'variations',
    ])
    expect(retiredWordsIn('a.tsx', 'const a = <p>Combining\n   changes…</p>')).toEqual([
      'combining changes',
    ])
    expect(retiredWordsIn('a.ts', "// there is no branch here\nconst a = 'ok'")).toEqual([])
    expect(retiredWordsIn('a.ts', "const a = 'document-thumbnail'")).toEqual([])
    expect(retiredWordsIn('a.ts', "import x from './merge-persistence.js'")).toEqual([])
    // The workspace-transfer merge is a live concept.
    expect(retiredWordsIn('a.ts', "const a = 'The workspace could not be merged here.'")).toEqual(
      [],
    )
  })

  const files = walkSourceFiles(join(REPO_ROOT, 'apps/web/src')).filter(isShipped)

  it('scans the shipped web source', () => {
    expect(files.length).toBeGreaterThan(400)
  })

  it('no shipped string names a retired noun', () => {
    const hits = files.flatMap((file) =>
      retiredWordsIn(file, readFileSync(file, 'utf8')).map(
        (word) => `${relativeToRepo(file)}: ${word}`,
      ),
    )
    expect(hits).toEqual([])
  })
})
