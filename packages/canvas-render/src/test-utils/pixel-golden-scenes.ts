/**
 * Text-free, geometry-only fixtures for the pixel-level golden regression
 * harness (`svg/pixel-golden.browser.test.ts`). Each builder covers exactly
 * one shape class that a byte-level SVG-string golden cannot protect: a
 * sweep-flag or coordinate-sign bug still produces well-formed, merely
 * byte-DIFFERENT XML (`svg/determinism.test.ts` would only catch it by
 * accident), while a screenshot pins the actual painted pixels — which side
 * of the line a hop bulges, which way an arrowhead points, how a corner
 * curves.
 *
 * Deliberately NOT in `golden-scene.ts`: that file backs the byte-level
 * determinism guarantee (Node and browser serialize identically). This file
 * backs a different guarantee (the painted pixels match a reviewed
 * baseline), so it never has to be touched — or regenerated — for the same
 * reason golden-scene.ts does.
 *
 * All coordinates below are integers and every edge is axis-aligned, so
 * every derived point (arrowhead wings, jump-hop entry/exit, rounded-corner
 * midpoints) stays integer too — the alignment `pixel-golden-scenes.test.ts`
 * asserts.
 *
 * ## Regenerating a baseline
 *
 * A screenshot diff is a rendering-format change and gets the same review
 * discipline as `golden-scene.ts`'s SVG-string goldens — regenerate ONLY as
 * a deliberate, reviewed act, never blindly to make a failing test pass:
 *
 * 1. From `packages/canvas-render`: `pnpm vitest run --project
 *    canvas-render-browser --update` (or `pnpm test:browser --update` from
 *    the repo root).
 * 2. Eyeball every regenerated PNG under `svg/__screenshots__/` for the
 *    INTENDED geometry — hop bulge on the drawn side, arrowhead orientation,
 *    corner curvature, rect radius — not just "a diff exists". `--update`
 *    happily photographs a bug as readily as a fix.
 * 3. Commit the PNGs in the same change as whatever justified the diff (a
 *    pinned chromium version bump, a deliberate rendering fix) — never
 *    bundled into an unrelated commit.
 *
 * Baseline filenames are platform/browser-suffixed (`-chromium-linux`) by
 * Vitest itself. CI runs linux chromium, so a baseline regenerated on a
 * non-linux machine is not CI-valid — regenerate on linux, or in CI.
 * `toMatchScreenshot` FAILS rather than auto-creating when a baseline is
 * missing, so a forgotten PNG commit is loud, not silently green.
 */
import { computeEdgeJumps } from '../layout/edge-jumps.js'
import type { ResolvedEdgeNode, Scene, ShapeSceneNode } from '../scene-graph.js'

const EDGE_APPEARANCE = { stroke: '#1f2933', strokeWidth: 2 } as const

/**
 * Two crossing edges: an earlier vertical edge and a later horizontal edge
 * that hops over it. `computeEdgeJumps` — the real edge pipeline's jump
 * producer, the same one `layoutSpatialCanvas` calls — derives the hop
 * point rather than a hand-authored jump, so this fixture exercises the
 * actual jump-detection geometry, not just the backend's drawing of one.
 * The crossing point (50, 20) is deliberately an intersection of two
 * integer-coordinate axis-aligned segments, so it lands on an integer too.
 */
export function buildJumpHopScene(): Scene {
  const earlier: ResolvedEdgeNode = {
    kind: 'edge',
    id: 'vertical',
    path: [
      { x: 50, y: 0 },
      { x: 50, y: 40 },
    ],
    fromSide: 'top',
    toSide: 'bottom',
    fromEnd: 'none',
    toEnd: 'none',
    appearance: EDGE_APPEARANCE,
  }
  const laterDraft: ResolvedEdgeNode = {
    kind: 'edge',
    id: 'horizontal',
    path: [
      { x: 0, y: 20 },
      { x: 100, y: 20 },
    ],
    fromSide: 'left',
    toSide: 'right',
    fromEnd: 'none',
    toEnd: 'none',
    appearance: EDGE_APPEARANCE,
  }
  const jumps = computeEdgeJumps([earlier, laterDraft]).get(laterDraft.id)
  const later: ResolvedEdgeNode = jumps !== undefined ? { ...laterDraft, jumps } : laterDraft
  return { nodes: [earlier, later] }
}

/**
 * A single bent edge with `rounded: true` — the backend draws its interior
 * vertex as a quadratic `Q` curve (`roundedPathData`/`roundedEdgeCorners`)
 * instead of a sharp corner. Even-integer vertices keep the corner's
 * midpoint control points (see `roundedEdgeCorners`) integer as well.
 */
export function buildRoundedCornersScene(): Scene {
  const edge: ResolvedEdgeNode = {
    kind: 'edge',
    id: 'bent',
    path: [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 120, y: 60 },
    ],
    fromSide: 'left',
    toSide: 'right',
    fromEnd: 'none',
    toEnd: 'none',
    rounded: true,
    appearance: EDGE_APPEARANCE,
  }
  return { nodes: [edge] }
}

/**
 * A horizontal and a vertical edge, each with BOTH ends arrowed — the
 * minimal pair that still shows all four triangle orientations (left/right
 * from the horizontal edge's two ends, up/down from the vertical edge's).
 * Kept separate so the two edges never overlap.
 */
export function buildArrowheadsScene(): Scene {
  const horizontal: ResolvedEdgeNode = {
    kind: 'edge',
    id: 'horizontal-arrows',
    path: [
      { x: 0, y: 20 },
      { x: 80, y: 20 },
    ],
    fromSide: 'left',
    toSide: 'right',
    fromEnd: 'arrow',
    toEnd: 'arrow',
    appearance: EDGE_APPEARANCE,
  }
  const vertical: ResolvedEdgeNode = {
    kind: 'edge',
    id: 'vertical-arrows',
    path: [
      { x: 140, y: 0 },
      { x: 140, y: 80 },
    ],
    fromSide: 'top',
    toSide: 'bottom',
    fromEnd: 'arrow',
    toEnd: 'arrow',
    appearance: EDGE_APPEARANCE,
  }
  return { nodes: [horizontal, vertical] }
}

/** A single shape node with a corner radius (`rx` on the emitted `<rect>`). */
export function buildRoundedRectScene(): Scene {
  const rect: ShapeSceneNode = {
    kind: 'shape',
    bbox: { x: 0, y: 0, w: 120, h: 80 },
    radius: 16,
    appearance: { fill: '#e0e7ff', stroke: '#1f2933', strokeWidth: 2 },
  }
  return { nodes: [rect] }
}
