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
 * A missing baseline is CREATED and the test still FAILS ("a new one was
 * created. Review it before running tests again"), so a forgotten PNG
 * commit is loud rather than silently green — and the review step is the
 * eyeballing above, not a second run.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { ResolvedEdgeNode, Scene, ShapeSceneNode } from '@kamiazya/whiteboard-scene'
import { computeEdgeJumps } from '../layout/edges/edge-jumps.js'
import { layoutSpatialCanvas, resolveCanvasPalette } from '../layout/spatial-canvas.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { createFakeMeasure } from './fake-measure.js'

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

/** All five non-rect silhouettes side by side — the arc-bearing cylinder is
 * the one a byte golden cannot protect (sweep flags), the rest ride along
 * so a proportion regression in any outline is equally loud. */
export function buildNodeOutlinesScene(): Scene {
  const appearance = { fill: '#e0e7ff', stroke: '#1f2933', strokeWidth: 2 }
  const shapes = [
    'visual.ellipse',
    'visual.diamond',
    'visual.hexagon',
    'visual.parallelogram',
    'visual.cylinder',
  ] as const
  return {
    nodes: shapes.map((shape, index) => ({
      kind: 'shape',
      bbox: { x: index * 140, y: 0, w: 120, h: 80 },
      shape,
      appearance,
    })),
  }
}

/** The whole vendored lucide subset at badge size — pins that the vendored
 * geometry actually draws the icons it claims (a bad path lands here as a
 * visibly wrong glyph, which no byte golden can notice). */
export function buildIconSetScene(): Scene {
  const icons = ['database', 'file', 'image', 'link', 'lock', 'star'] as const
  return {
    nodes: icons.map((icon, index) => ({
      kind: 'icon',
      icon,
      bbox: { x: index * 40, y: 0, w: 32, h: 32 },
      appearance: { stroke: '#1f2933' },
    })),
  }
}

/**
 * The one canvas both LOOK goldens are built from — a colour-preset text
 * node inside a group frame, an uncoloured one, an ellipse silhouette, and
 * three edges of which two cross. It exists because the rest of this file
 * pins CRISP geometry only: a change to sketch ink or to neon's glow moved
 * no committed pixel, so the whole look layer had no instrument.
 *
 * Text-free like every other fixture here, and for a harder reason than the
 * human decision that made the rest so: a baseline is compared at zero
 * mismatched pixels across machines whose installed FONTS differ (CI paints
 * with the system Google Chrome on a runner carrying neither this
 * container's font set nor the themes' own faces), so a rendered glyph is
 * the one thing in a scene that cannot be reproduced. Bodies are therefore
 * laid out through an empty parse.
 */
const LOOK_CANVAS: SpatialCanvas = {
  nodes: [
    { id: 'frame', type: 'group', x: 0, y: 0, width: 260, height: 200 },
    { id: 'preset', type: 'text', x: 40, y: 60, width: 160, height: 80, text: '', color: '5' },
    { id: 'plain', type: 'text', x: 400, y: 60, width: 160, height: 80, text: '' },
    { id: 'sink', type: 'text', x: 40, y: 320, width: 160, height: 80, text: '' },
    {
      id: 'oval',
      type: 'text',
      x: 400,
      y: 320,
      width: 160,
      height: 80,
      text: '',
      'x-whiteboard': { facets: { 'visual.shape/v0': { kind: 'ellipse' } } },
    },
  ],
  edges: [
    { id: 'across', fromNode: 'preset', toNode: 'plain', toEnd: 'arrow' },
    // The two diagonals of the four content nodes, so one hops the other.
    { id: 'falling', fromNode: 'preset', toNode: 'oval', fromSide: 'bottom', toSide: 'top' },
    { id: 'rising', fromNode: 'sink', toNode: 'plain', fromSide: 'top', toSide: 'bottom' },
  ],
  // Jump arcs are off unless a canvas asks for them, and a hop is one of the
  // shapes the crisp lane already pins — so the look goldens see it too.
  // `style` is left unsaid so each theme's own routing default still decides.
  'x-whiteboard': { facets: { 'visual.edges/v0': { lineJumps: 'arc' } } },
}

/** A look golden: the scene plus the theme's own paper, since a halo on the
 *  wrong ground says nothing about how bright it is. */
export interface LookScene {
  readonly scene: Scene
  readonly background: string
}

function buildLookScene(theme: string, mode: 'light' | 'dark'): LookScene {
  const canvas: SpatialCanvas = {
    ...LOOK_CANVAS,
    'x-whiteboard': {
      facets: { ...LOOK_CANVAS['x-whiteboard']?.facets, 'visual.theme/v0': { theme } },
    },
  }
  return {
    scene: layoutSpatialCanvas(canvas, {
      measure: createFakeMeasure(),
      // Text-free by construction — see LOOK_CANVAS.
      parseBody: () => ({ type: 'root', children: [] }),
      appearance: createSpatialTheme({ mode }),
      // The bundled themes reach the canvas through the DEFAULT render
      // contributions; `document` is what honours the facet at all.
      style: 'document',
    }),
    // Read from the theme rather than restated as a hex here: a paper colour
    // written twice is the drift class this package already names, and the
    // second copy is the one nothing would have caught.
    background: resolveCanvasPalette(canvas, mode).surface,
  }
}

/** `visual.sketch` on its own paper: jittered two-pass outlines, a hatched
 *  preset node, a dashed group frame, straight routing. */
export function buildSketchLookScene(): LookScene {
  return buildLookScene('visual.sketch', 'light')
}

/** `visual.neon` on its own deep ground: crisp geometry under a halo of each
 *  element's own paint, orthogonal routing. */
export function buildNeonLookScene(): LookScene {
  return buildLookScene('visual.neon', 'dark')
}
