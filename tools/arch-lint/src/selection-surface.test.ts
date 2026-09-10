/**
 * ONE drawing of "pick one of N", across every package and both roots.
 *
 * `apps/web`'s `toggle-state-surface.test.ts` is the closest existing rung
 * and could not have caught this: it scans `apps/web/src` only, and knows
 * only `aria-pressed` / `aria-expanded`. Both limits mattered. The
 * divergence lived largely in `packages/` — `facet-ui`'s derived form and
 * `plugin-visual`'s hand-written symbol editor drew two different controls
 * for one job, and neither file was in any scan — and half the spellings
 * used `aria-checked` or a bare radio, which that guard has no word for.
 * Measured before this: six spellings, four of them inside a single
 * settings panel.
 *
 * So the scan runs from `tools/arch-lint`, where node can read the whole
 * tree, and it asks one question of every selection control it finds: does
 * it come from `facet-ui`'s primitive, or is it listed here with a reason?
 *
 * What it deliberately does NOT do is claim every pick-one control in the
 * app must look identical. A card grid on a settings page (an icon over a
 * label, in a full-width cell) is a different control from a property row's
 * inline chip, and squeezing one into the other would be worse UI, not more
 * consistent. Those are exemptions WITH REASONS rather than a silent hole —
 * which is the point: a bare exemption is the omission with a word in front
 * of it, so each entry says what shape it is and why the chip is wrong for
 * it, and an entry naming a file that no longer holds a control fails.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** Every place a React selection control can be written. */
const SCAN_DIRS = [
  'apps/web/src',
  'packages/facet-ui/src',
  'packages/plugin-visual/src',
  'packages/canvas-viewer/src',
]

/**
 * What a selection control looks like in source. Each is a marker a
 * hand-written picker leaves and the shared primitive does not — the
 * primitive lives in ONE file, which is exempt for the reason a definition
 * always is.
 */
const MARKERS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /role=["']radiogroup["']/, what: 'role="radiogroup"' },
  { pattern: /role=["']radio["']/, what: 'role="radio"' },
  { pattern: /role=["']menuitemradio["']/, what: 'role="menuitemradio"' },
  { pattern: /type=["']radio["']/, what: '<input type="radio">' },
  { pattern: /aria-checked=\{/, what: 'aria-checked={…}' },
]

/**
 * Files that legitimately hold a selection marker. Each says WHAT SHAPE the
 * control is and why the inline chip is the wrong instrument for it.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'packages/facet-ui/src/option-group.tsx':
    'the primitive itself — the one definition every other surface composes',
  'apps/web/src/pages/SettingsPage.tsx':
    'CARD GRIDS (an icon over a label, full-width cells) for theme and tab-icon, not property rows: the chip is a 28px inline control beside a label, and collapsing a settings card into one would lose the icon that carries the meaning',
  'apps/web/src/components/workspace-files/NewDocumentDialog.tsx':
    'a dialog form with native radios and their labels VISIBLE, which is right for a form somebody fills in once — the chip hides its radio because a property row is adjusted repeatedly and reads as a value, not as a question',
  'apps/web/src/components/spatial-editor/ContextMenu.tsx':
    'ONE control: the colour rows custom-hex swatch, which is a radio that also DISCLOSES a panel (it carries aria-expanded beside aria-checked) and paints a gradient rather than a glyph — the primitive draws neither. Its option rows themselves go through the primitive, and are pinned structurally by canvas-settings.browser.test.tsx',
}

/**
 * Comments out, before anything is matched.
 *
 * A file that DESCRIBES a marker in prose is not drawing one, and demanding
 * an entry for it trains people to write an exemption to shut the scan up
 * — which is how a list full of true-looking entries stops meaning
 * anything. Found immediately: this rule's own explanation of the menu
 * shell, sitting in `ContextMenu.tsx`, was the scan's first offender.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Test files are exempt: asserting ABOUT a marker is not drawing one. */
function isSource(path: string): boolean {
  return (
    (path.endsWith('.tsx') || path.endsWith('.ts')) &&
    !path.includes('.test.') &&
    !path.includes(`${sep}test-utils${sep}`)
  )
}

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, found)
    else if (isSource(full)) found.push(full)
  }
  return found
}

interface Hit {
  readonly path: string
  readonly what: string
}

function scan(): { readonly hits: readonly Hit[]; readonly files: number } {
  const hits: Hit[] = []
  let files = 0
  for (const dir of SCAN_DIRS) {
    for (const full of walk(join(REPO_ROOT, dir))) {
      files += 1
      const source = stripComments(readFileSync(full, 'utf8'))
      const path = relative(REPO_ROOT, full).split(sep).join('/')
      for (const { pattern, what } of MARKERS) {
        if (pattern.test(source)) hits.push({ path, what })
      }
    }
  }
  return { hits, files }
}

describe('one selection control', () => {
  const { hits, files } = scan()

  // A scan that matched nothing reports itself as "everything is clean",
  // which is the failure mode this whole file exists to make impossible.
  it('scans a real population', () => {
    expect(files).toBeGreaterThan(200)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('finds no hand-written picker outside the primitive', () => {
    const offenders = [
      ...new Set(hits.filter((h) => !(h.path in EXEMPT)).map((h) => h.path)),
    ].sort()
    expect(offenders).toEqual([])
  })

  // The other side of the same list: an exemption cannot outlive the
  // control it names. A file that stops holding a picker — because it was
  // moved onto the primitive, or deleted — must drop out of this list, or
  // the list slowly becomes a record of what USED to be true.
  it('keeps no exemption for a file that no longer holds one', () => {
    const holding = new Set(hits.map((h) => h.path))
    expect(Object.keys(EXEMPT).filter((path) => !holding.has(path))).toEqual([])
  })

  it('gives every exemption a reason a reader can weigh', () => {
    for (const [path, reason] of Object.entries(EXEMPT)) {
      expect(reason.split(' ').length, `${path}'s reason is too short to be one`).toBeGreaterThan(6)
    }
  })

  // Mutation-check, in the file rather than by hand: the markers have to
  // actually fire. A regex that stops matching reports every file as clean.
  it('detects each marker shape, so clean means clean rather than blind', () => {
    const samples = [
      '<span role="radiogroup" aria-label="Theme">',
      '<button role="radio" aria-checked={on} />',
      '<button role="menuitemradio" />',
      '<input type="radio" name="x" />',
      '<div aria-checked={selected} />',
    ]
    for (const sample of samples) {
      expect(
        MARKERS.some(({ pattern }) => pattern.test(sample)),
        `no marker matched ${sample}`,
      ).toBe(true)
    }
  })
})
