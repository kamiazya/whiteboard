/**
 * The manipulation layer — selection, handles, connect, marquee, snap
 * guides — speaks ONE color vocabulary, defined once in index.css and read
 * everywhere as var(--manipulation*).
 *
 * Before this, three vocabularies coexisted: a hardcoded #2563eb across
 * four overlays (blind to dark mode), a hardcoded #e11d48 on the snap
 * guides (red is this product's reserved destructive color), and one
 * accidental currentColor. A raw hex in an overlay is how that state
 * returns, so this guard rejects the next one the way
 * polite-live-region.test.ts rejects the next display:none live region:
 * source-level, via Vite's build-time raw glob. (`?raw` on CSS returns an
 * empty string — the CSS plugin claims it first — so the both-themes half
 * of this contract lives in manipulation-tokens.browser.test.tsx, where the
 * real stylesheet is loaded and computed styles can be read.)
 */
import { describe, expect, it } from 'vitest'

const overlaySources = import.meta.glob(
  [
    './SelectionOverlay.tsx',
    './ConnectOverlay.tsx',
    './MemberOutlinesOverlay.tsx',
    './DragPreviewLayer.tsx',
    './SpatialEditor.tsx',
  ],
  { query: '?raw', eager: true, import: 'default' },
) as Record<string, string>

/**
 * A hex color literal in JSX/TSX source. The manipulation tokens are the
 * only sanctioned way to color an overlay; node/edge CONTENT colors flow
 * through the palette module, not through literals in these files either.
 */
const HEX_LITERAL = /(?:stroke|fill|color)\s*[:=]\s*["'{]*#[0-9a-fA-F]{3,8}\b/g

describe('manipulation overlays read tokens, not hex literals', () => {
  it('scans the overlay set it claims to', () => {
    expect(Object.keys(overlaySources)).toHaveLength(5)
  })

  it('has no raw hex color in any overlay source', () => {
    const offenders = Object.entries(overlaySources).flatMap(([path, source]) =>
      [...source.matchAll(HEX_LITERAL)].map(
        (m) => `${path}:${source.slice(0, m.index).split('\n').length} ${m[0]}`,
      ),
    )
    expect(
      offenders,
      `Color through var(--manipulation*) so dark mode and the palette stay one decision: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})
