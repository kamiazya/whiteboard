// @vitest-environment node
/**
 * Every small round badge on a control speaks ONE colour.
 *
 * The app already had one — the settings nudge, "a setup step is waiting" —
 * in `#3b6ecc`, which BRAND.md reserves as the blue spark, the AI's hand,
 * and the hue its favicon's syncing dot deliberately reuses because "the
 * system is at work" is the same semantic family as the AI acting.
 *
 * The changed-since-you-looked dot shipped in `sky-500` instead: a SECOND
 * blue for a signal in that same family, invented rather than found. This
 * scan is the rung that stops the third one. It asserts the literal is
 * shared rather than naming the colour, so a brand change moves one value
 * and nothing here needs editing.
 *
 * Deliberately NOT a token: `#3b6ecc` is a brand constant spelled raw in
 * `favicon.ts`, `celebrate.ts` and the marks, and BRAND.md is its source of
 * truth. Folding those into a CSS variable is a wider increment than this
 * file's subject, and a token would not reach the favicon or the OG card,
 * which are painted outside the theme.
 *
 * `?raw` rather than `node:fs`: apps/web is browser-only and
 * `web-app-boundary.test.ts` enforces it.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(
  ['./components/AppShell.tsx', './components/workspace-files/FolderContentsList.tsx'],
  { query: '?raw', eager: true, import: 'default' },
) as Record<string, string>

/** A `bg-[#rrggbb]` on an element that also carries the badge idiom's ring. */
const BADGE = /className="[^"]*\brounded-full\b[^"]*"/g
const HEX = /bg-\[(#[0-9a-fA-F]{6})\]/

function badgeColours(source: string): string[] {
  return [...source.matchAll(BADGE)]
    .map((match) => match[0].match(HEX)?.[1])
    .filter((hex): hex is string => hex !== undefined)
}

describe('badge colour is spoken once', () => {
  const found = Object.entries(sources).flatMap(([file, source]) =>
    badgeColours(source).map((hex) => ({ file, hex })),
  )

  // The count proves the scan reaches its subject: a regex that stopped
  // matching would otherwise report perfect agreement over nothing.
  it('finds a hex badge in both files that carry one', () => {
    expect(new Set(found.map((each) => each.file)).size).toBe(2)
  })

  it('agrees on one colour across every badge', () => {
    expect(new Set(found.map((each) => each.hex)).size).toBe(1)
  })
})
