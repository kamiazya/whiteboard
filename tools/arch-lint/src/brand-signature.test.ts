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

/**
 * What each surface holding the mark IS. `mark` draws the bare signature and
 * must use the box BRAND.md states; `composes` builds something around it and
 * needs a box of its own, saying what it adds.
 *
 * Every file the scan finds must appear here, and every entry must name a
 * file it still finds — so a new brand surface cannot be added without
 * answering which kind it is, which is the question that went unasked while
 * the doc and the surfaces disagreed.
 */
const SURFACES: Readonly<Record<string, string>> = {
  'apps/web/src/brand/welcome-mark.svg': 'mark',
  'apps/web/src/brand/loader-mark.svg': 'mark',
  'apps/web/src/brand/error-mark.svg': 'mark',
  'apps/web/src/components/shell/ShellMark.tsx': 'mark',
  'packages/canvas-viewer/canvas-viewer.widget.html': 'mark',
  'apps/web/public/boot-splash.svg':
    'composes: the product STORY — a cursor, nodes and edges, the spark, and the mark landing at the end. Its canvas is the scene, not the mark.',
  'docs/assets/readme-mark.svg':
    'composes: the framed and captioned lockup, which BRAND.md gives the README hero. Frame plus wordmark need a canvas well past the mark.',
  'apps/web/scripts/generate-og-image.mjs':
    'composes: the framed card with the spark. The board frame is a 84x62 rect at (2,2), so its bottom edge plus stroke reaches y~65.3 — a 56-tall box would clip it, which is why this one is 66.',
  'apps/web/scripts/generate-pwa-icons.mjs':
    'composes: a launcher icon at whatever size it is asked for, so its box is the size parameter rather than a constant.',
  'packages/plugin-visual/src/icons/signature.ts':
    'composes: the mark CROPPED to itself plus halo room, for a 16px picker glyph where the standard box spends half its width on margin. Its own comment carries the bounds.',
  'apps/web/src/lib/favicon.ts':
    'composes: nothing — it QUOTES the path in a comment to say where the favicon geometry came from, and draws no SVG of its own.',
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

/**
 * The box the mark's own surfaces draw it in, read from the same BRAND.md
 * line as the path. The doc said `88x66` while every mark-only surface drew
 * `88x56`, so the doc was the odd one out (user decision, 2026-09-11) — and
 * the fix for a disagreement nobody could see is to make one side derive
 * from the other, which is why this is parsed rather than typed here.
 */
function canonicalBox(): string {
  const doc = readFileSync(join(REPO_ROOT, BRAND_DOC), 'utf8')
  const found = doc.match(/in an (\d+)x(\d+) box/)
  if (found === null) throw new Error(`${BRAND_DOC} no longer states the mark's box`)
  return `viewBox="0 0 ${found[1]} ${found[2]}"`
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
  const box = canonicalBox()
  const { copies, files } = findCopies()
  const surfaces = [...new Set(copies.map((copy) => copy.path))].sort()

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

  /**
   * Both sides of the surface map. A file holding the mark and not listed is
   * a surface nobody classified — which is exactly the state the box spent
   * however long in, the doc saying one thing and every surface drawing
   * another with nothing to notice.
   */
  it('classifies every surface that holds the mark, and lists none that does not', () => {
    const unclassified = surfaces.filter((path) => SURFACES[path] === undefined)
    expect(unclassified).toEqual([])
    const stale = Object.keys(SURFACES).filter((path) => !surfaces.includes(path))
    expect(stale).toEqual([])
  })

  it('draws the bare mark in the box BRAND.md states, wherever it is the mark', () => {
    const wrongBox = surfaces
      .filter((path) => SURFACES[path] === 'mark')
      .filter((path) => !readFileSync(join(REPO_ROOT, path), 'utf8').includes(box))
      .map((path) => `${path} does not draw ${box}`)
    expect(wrongBox).toEqual([])
  })

  it('says what a composing surface adds, so its own box is a decision', () => {
    const unexplained = Object.entries(SURFACES)
      .filter(([, kind]) => kind !== 'mark')
      .filter(([, kind]) => !kind.startsWith('composes:') || kind.split(/\s+/).length < 8)
      .map(([path]) => path)
    expect(unexplained).toEqual([])
  })
})
