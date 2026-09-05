// @vitest-environment node
/**
 * A control that TOGGLES something must express its state from its ARIA
 * attribute, not from a parallel boolean.
 *
 * Three spellings for one idea were in the tree at once, and the reader can
 * only tell them apart by opening each file:
 *
 * - derived — `aria-pressed:bg-accent` in the class, so `aria-pressed={open}`
 *   is the ONE place the state is written;
 * - doubled — `aria-pressed={open}` plus `open && 'bg-accent …'`, where an
 *   editor who changes one and not the other leaves the picture disagreeing
 *   with what a screen reader is told;
 * - absent — the attribute alone. Announced, invisible. Found in the running
 *   app: a rail whose opener looked identical open and closed.
 *
 * The scan reads the OPENING TAG of every element carrying a dynamic
 * `aria-pressed`/`aria-expanded` and requires the state to be derived there.
 * `?raw` rather than `node:fs`: apps/web is browser-only and
 * `web-app-boundary.test.ts` enforces it.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('./**/*.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

/** The `.ts` half, where shared class constants live (`ui/dock-button.ts`). */
const moduleSources = import.meta.glob('./**/*.ts', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

/** Only a DYNAMIC value is a state; a bare `aria-expanded` is a combobox's static role marker. */
const TOGGLE_ATTRIBUTE = /aria-(?:pressed|expanded)=\{/g

/**
 * The opening tag an attribute sits in.
 *
 * Walking forward to the first `>` is wrong and quietly so: `onClick={() =>
 * …}` puts a `>` inside the tag, so a naive slice ends before the className
 * and every site reads as "no state expressed". Depth-tracking over `{}` is
 * what makes the slice the actual tag.
 */
function openingTagAround(source: string, index: number): string {
  let start = index
  while (start > 0 && source[start] !== '<') start -= 1
  let depth = 0
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const char = source[cursor]
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (char === '>' && depth === 0) return source.slice(start, cursor + 1)
  }
  return source.slice(start)
}

const VARIANT = /aria-(?:pressed|expanded):/

/**
 * Class constants that already carry the variants, DERIVED rather than
 * listed. `TOOL_BUTTON_CLASS` composes `TOGGLE_STATE_CLASS`, so a tag wearing
 * it derives its state too — and a hand-written list of such names is one
 * more thing to keep in step, which is the defect one level up.
 */
const derivingConstants = new Set(['TOGGLE_STATE_CLASS'])
for (const source of Object.values({ ...sources, ...moduleSources })) {
  // The value window STOPS at the next declaration. Letting it run three
  // lines unconditionally made one constant swallow the ones after it, so
  // `TOOL_BUTTON_CLASS` never got a match of its own and the neighbour above
  // it was credited with the variant instead.
  for (const match of source.matchAll(
    /const\s+([A-Z][A-Z0-9_]*)\s*=\s*([^\n]*(?:\n(?!\s*(?:export\s+)?const\b)[^\n]*){0,3})/g,
  )) {
    const [, name, value] = match
    if (name === undefined || value === undefined) continue
    if (VARIANT.test(value) || value.includes('TOGGLE_STATE_CLASS')) derivingConstants.add(name)
  }
}

/** The state is derived when the tag names an ARIA variant, directly or through such a class. */
function derivesState(tag: string): boolean {
  if (VARIANT.test(tag)) return true
  return [...derivingConstants].some((name) => tag.includes(name))
}

/**
 * Sites where the attribute is real and an accent background would be wrong.
 * Each says why, so an entry cannot outlive its reason.
 */
const EXEMPT: Record<string, string> = {
  './components/workspace-files/WorkspaceFileTree.tsx':
    'a disclosure triangle: the chevron ROTATES, which is the state expression a tree row wants',
  './components/workspace-files/WorkspaceFolderTree.tsx':
    'a disclosure triangle, same as the file tree',
  './components/workspace-top-bar/VersionPanel.tsx':
    'a grab handle whose CHEVRON swaps (ChevronDown expanded, ChevronUp collapsed), so the state is shown by the glyph rather than by a background — the same shape as the two trees above',
  './components/spatial-editor/ContextMenu.tsx':
    'its aria-expanded is the colour SUBMENU while its bg-accent is the SELECTED colour — two different subjects, so deriving one from the other would be wrong',
}

function offenders(entries: Record<string, string>): string[] {
  const found: string[] = []
  for (const [path, source] of Object.entries(entries)) {
    if (path in EXEMPT) continue
    for (const match of source.matchAll(TOGGLE_ATTRIBUTE)) {
      const tag = openingTagAround(source, match.index)
      if (!derivesState(tag)) found.push(path)
    }
  }
  return [...new Set(found)].sort()
}

describe('a toggle expresses its state from its ARIA attribute', () => {
  it('scans a real population, so an empty result cannot mean the glob matched nothing', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50)
    const toggles = Object.values(sources).filter((s) => TOGGLE_ATTRIBUTE.test(s)).length
    expect(toggles).toBeGreaterThan(5)
  })

  it('finds no control that announces a state it does not show', () => {
    expect(offenders(sources)).toEqual([])
  })

  it('detects each shape, so clean means clean rather than blind', () => {
    // Absent: the attribute with no styling at all.
    expect(
      offenders({ './x.tsx': `<button aria-expanded={open} className="rounded p-1" />` }),
    ).toEqual(['./x.tsx'])
    // Doubled: the state written a second time as a conditional.
    expect(
      offenders({
        './x.tsx': `<button aria-pressed={on} className={cn(BASE, on && 'bg-accent')} />`,
      }),
    ).toEqual(['./x.tsx'])
    // Derived inline, and derived through the shared class, both pass.
    expect(
      offenders({ './x.tsx': `<button aria-pressed={on} className="aria-pressed:bg-accent" />` }),
    ).toEqual([])
    expect(
      offenders({ './x.tsx': `<button aria-pressed={on} className={TOGGLE_STATE_CLASS} />` }),
    ).toEqual([])
    // A `>` inside an arrow-function prop must not end the tag early.
    expect(
      offenders({
        './x.tsx': `<button onClick={() => setOpen(true)} aria-pressed={on} className={TOGGLE_STATE_CLASS} />`,
      }),
    ).toEqual([])
  })
})
