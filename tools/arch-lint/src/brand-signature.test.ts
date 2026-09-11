/**
 * "Every brand surface renders this exact path" — BRAND.md's own sentence,
 * made executable.
 *
 * It was prose alone, and the mark is copied into THIRTEEN places: a React
 * component, five standalone SVGs, two PNG generators, the widget's inline
 * splash, the docs hero, a plugin's registered geometry, and a prose comment
 * that quotes it. None was pinned against any other, so a copy could be
 * edited, truncated, or "tidied" in one surface and the rest would go on
 * drawing the old mark. Nothing would be red; the product would simply have
 * two signatures, and the one a person met would depend on which screen they
 * were on.
 *
 * The scan runs from `tools/arch-lint` because that is where node reads the
 * whole tree — the copies span both composition roots, two packages and
 * `docs/`, so no per-package guard could see them all.
 *
 * The canonical path is READ FROM BRAND.md rather than written here. That
 * file governs the mark, so a guard carrying its own copy would be a
 * fourteenth one to keep in step — and the first to drift, since nothing
 * would be checking it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const BRAND_DOC = 'apps/web/BRAND.md'
const SELF = 'tools/arch-lint/src/brand-signature.test.ts'

/**
 * The mark's opening, distinctive enough that nothing else in the tree
 * starts with it. Matching a PREFIX rather than the whole path is what makes
 * a truncated or edited copy visible: matching the full path would find only
 * the copies that are already correct and report a clean sweep.
 */
const SIGNATURE_PREFIX = 'M20 44 C 27 22'

/**
 * The path expression that follows, in SVG path characters only. The letters
 * are the path COMMANDS and nothing else, which is what stops the capture
 * running off the end of a sentence — `favicon.ts` quotes the mark mid-prose
 * (`… 68 25 in`), and a charset with a general `[a-z]` in it would have
 * swallowed the `in` and reported that copy as divergent.
 */
const PATH_CHARS = /[MmLlHhVvCcSsQqTtAaZz0-9 ,.-]*/.source

const SIGNATURE_RE = new RegExp(`${SIGNATURE_PREFIX}${PATH_CHARS}`, 'g')

/** Directories with nothing hand-authored in them. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'tmp',
  '.vitest',
  '.turbo',
  '.wrangler',
])

/**
 * Copies that deliberately differ, each saying HOW and why. A bare exemption
 * is the omission with a word in front of it, and the both-sides check below
 * means an entry cannot outlive the divergence it names.
 */
const DIVERGENT: Readonly<Record<string, string>> = {
  'apps/web/src/brand/error-mark.svg':
    'the ERROR mark: the signature carries on into a scribble, so it shares the opening and then deliberately does not stop where the plain mark does. That IS the artwork — a pen that kept going — and holding it to the canonical path would delete the only thing it says.',
}

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, found)
    else found.push(full)
  }
  return found
}

interface Copy {
  readonly path: string
  readonly value: string
}

function canonicalPath(): string {
  const doc = readFileSync(join(REPO_ROOT, BRAND_DOC), 'utf8')
  const found = doc.match(new RegExp(`${SIGNATURE_PREFIX}${PATH_CHARS}`))
  if (found === null) throw new Error(`${BRAND_DOC} no longer quotes the signature path`)
  return found[0].trim()
}

function findCopies(): { readonly copies: readonly Copy[]; readonly files: number } {
  const copies: Copy[] = []
  let files = 0
  for (const full of walk(REPO_ROOT)) {
    files += 1
    let source: string
    try {
      source = readFileSync(full, 'utf8')
    } catch {
      // A binary the walk picked up (a PNG, a font). Nothing to read.
      continue
    }
    if (!source.includes(SIGNATURE_PREFIX)) continue
    const path = relative(REPO_ROOT, full).split(sep).join('/')
    // BRAND.md is the source, not a copy of it — and this file holds the
    // PREFIX it searches for, which is a definition rather than a drawing.
    // (Its own first run reported itself, which is the same shape
    // `selection-surface.test.ts` hit: a file that names a marker is not
    // one that draws it.) Every other test stays in scope on purpose — a
    // fixture asserting a stale path is exactly the load-bearing copy a
    // sweep leaves behind.
    if (path === BRAND_DOC || path === SELF) continue
    for (const match of source.matchAll(SIGNATURE_RE)) {
      copies.push({ path, value: match[0].trim() })
    }
  }
  return { copies, files }
}

describe('the brand signature is one path', () => {
  const canonical = canonicalPath()
  const { copies, files } = findCopies()

  /**
   * A scan that matched nothing reports itself as "every copy agrees", which
   * is the failure this file exists to make impossible. Both halves are
   * counted: the population it walked, and the copies it actually found.
   */
  it('reads a real population, and finds the copies it is judging', () => {
    expect(files).toBeGreaterThan(500)
    // Twelve at the time of writing, across both roots, two packages and
    // docs. A floor rather than an equality: adding a brand surface is
    // ordinary work, and this guard should welcome one rather than fail it.
    expect(copies.length).toBeGreaterThanOrEqual(10)
  })

  it('takes its canonical path from BRAND.md, which governs the mark', () => {
    // Not a tautology: it pins that what the doc quotes is a whole path
    // rather than a truncated one, which is the way this single source
    // could itself go wrong.
    expect(canonical.startsWith(SIGNATURE_PREFIX)).toBe(true)
    expect(canonical.endsWith('68 25')).toBe(true)
  })

  it('renders that exact path everywhere, or says where it deliberately does not', () => {
    const wrong = copies
      .filter((copy) => copy.value !== canonical && DIVERGENT[copy.path] === undefined)
      .map((copy) => `${copy.path}\n    expected: ${canonical}\n    found:    ${copy.value}`)
    expect(wrong).toEqual([])
  })

  /**
   * The other side of the allowlist. An entry that no longer names a
   * divergent copy is a hole somebody could write a new one into without
   * the scan noticing — and it reads, to anyone auditing the list, exactly
   * like a divergence that is still deliberate.
   */
  it('keeps no entry for a copy that no longer diverges', () => {
    const stale = Object.keys(DIVERGENT).filter(
      (path) => !copies.some((copy) => copy.path === path && copy.value !== canonical),
    )
    expect(stale).toEqual([])
  })

  it('gives every divergence a reason, not a bare exemption', () => {
    const unexplained = Object.entries(DIVERGENT)
      .filter(([, reason]) => reason.trim().split(/\s+/).length < 8)
      .map(([path]) => path)
    expect(unexplained).toEqual([])
  })
})
