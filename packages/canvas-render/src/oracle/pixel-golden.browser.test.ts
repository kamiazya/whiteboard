// Pixel-level regression harness for the shape classes a byte-level SVG-
// string golden cannot protect: a sweep-flag or coordinate-sign bug still
// produces well-formed, merely byte-DIFFERENT XML, so a string-equality golden
// only catches it by accident. `toMatchScreenshot` pins the actual painted
// pixels instead.
//
// What it paints is the recorded `pixel-mount/` picture of each golden in
// svg.jsonl, which the Rust SVG backend is held to byte for byte
// (`svg_oracle.rs`), so these screenshots judge the core's drawing. The scenes
// are the frozen `pixel/*` rows of the same file: text-free (a glyph would make
// a baseline a claim about the machine's fonts) and, for the hand-authored
// ones, integer-aligned, which `svg-recorded-oracle.test.ts` holds.
//
// ## Regenerating a baseline
//
// A screenshot diff is a rendering-format change and gets the same review
// discipline as a byte-level SVG golden: regenerate ONLY as a deliberate,
// reviewed act, never blindly to make a failing test pass.
//
// 1. From `packages/canvas-render`: `pnpm vitest run --project
//    canvas-render-browser --update` (or `pnpm test:browser --update` from
//    the repo root).
// 2. Eyeball every regenerated PNG under `oracle/__screenshots__/` for the
//    INTENDED geometry (hop bulge on the drawn side, arrowhead orientation,
//    corner curvature, rect radius), not just "a diff exists". `--update`
//    photographs a bug as readily as a fix.
// 3. Commit the PNGs in the same change as whatever justified the diff (a
//    pinned chromium version bump, a deliberate rendering fix), never
//    bundled into an unrelated commit.
//
// Baseline filenames are platform/browser-suffixed (`-chromium-linux`) by
// Vitest. CI runs linux chromium, so a baseline regenerated elsewhere is not
// CI-valid: take CI's. When `test-browser` fails, download the run's
// `browser-traces-test-browser-<shard>-attempt-<n>` artifact; under
// `.vitest/attachments/src/oracle/pixel-golden.browser.test.ts/` a missing
// baseline left `<scene>-reference-chromium-linux.png` and a mismatch left
// `<scene>-actual-chromium-linux.png`. Eyeball it (step 2), then commit it as
// `src/oracle/__screenshots__/pixel-golden.browser.test.ts/<scene>-chromium-linux.png`,
// dropping the `-reference`/`-actual` infix. Only `-chromium-linux` baselines
// are committed, so the harness skips off linux (saying so) rather than
// writing one, and `oracle/pixel-golden-baselines.test.ts` fails on a scene
// without one or on a baseline for any other platform. A missing baseline is
// CREATED and the test still FAILS, so a forgotten PNG commit is loud.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page, server } from 'vitest/browser'
import type { SvgRecord } from '../test-utils/render-oracle/oracle.js'
import recording from './svg.jsonl?raw'

const MOUNTED = new Map(
  recording
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as SvgRecord)
    .filter((record) => record.id.startsWith('pixel-mount/'))
    .map((record) => [record.id.slice('pixel-mount/'.length), record.svg]),
)

/**
 * Mounts the recorded picture of the golden `name` as the page's only
 * content, tagged for `page.getByTestId`. The `<svg>`'s own `width`/`height`
 * attributes (the scene's integer bounds plus the padding) size the element,
 * so the locator's screenshot is cropped tightly to the drawn content rather
 * than the full fixed viewport.
 */
function mountScene(name: string, testId: string): void {
  const markup = MOUNTED.get(name)
  if (markup === undefined) throw new Error(`svg.jsonl holds no pixel-mount/${name}`)
  const container = document.createElement('div')
  container.innerHTML = markup
  const svg = container.firstElementChild
  if (svg === null) throw new Error(`pixel-mount/${name} has no root element`)
  svg.setAttribute('data-testid', testId)
  document.body.append(svg)
}

// biome-ignore lint/plugin: SVG markup appended raw, no React root to unmount
afterEach(() => {
  document.body.innerHTML = ''
})

// The committed baselines are `-chromium-linux` only, because CI is the one
// place a baseline is checked and CI is linux. Anywhere else Vitest finds no
// baseline, writes one from the local render and fails — and the next run is
// green against a PNG nobody reviewed. So off linux this skips, saying why;
// `server.platform` is the browser server's own `process.platform`, the same
// value Vitest suffixes the baseline name with. `pixel-golden-baselines.test.ts`
// holds the committed set to linux-only and complete.
const BASELINE_PLATFORM = 'linux'

describe('pixel-level golden regression (real browser)', () => {
  beforeEach(({ skip }) => {
    skip(
      server.platform !== BASELINE_PLATFORM,
      `pixel baselines are ${BASELINE_PLATFORM}-only (CI); this browser server runs on ${server.platform}. ` +
        "Regenerate on linux as this file's header describes.",
    )
  })

  it('jump-hop: the later edge hops over the earlier, bulging to the drawn side', async () => {
    mountScene('jump-hop', 'jump-hop')
    await expect.element(page.getByTestId('jump-hop')).toMatchScreenshot('jump-hop')
  })

  it('rounded-corners: a bent edge draws its interior vertex as a Q-curve', async () => {
    mountScene('rounded-corners', 'rounded-corners')
    await expect.element(page.getByTestId('rounded-corners')).toMatchScreenshot('rounded-corners')
  })

  it('arrowheads: triangle orientation at each end (left/right/up/down)', async () => {
    mountScene('arrowheads', 'arrowheads')
    await expect.element(page.getByTestId('arrowheads')).toMatchScreenshot('arrowheads')
  })

  it('rect-radius: a shape node with a corner radius renders rx', async () => {
    mountScene('rounded-rect', 'rect-radius')
    await expect.element(page.getByTestId('rect-radius')).toMatchScreenshot('rect-radius')
  })

  it('node-outlines: the five non-rect silhouettes, cylinder arcs included', async () => {
    mountScene('node-outlines', 'node-outlines')
    await expect.element(page.getByTestId('node-outlines')).toMatchScreenshot('node-outlines')
  })

  it('icon-set: every vendored lucide glyph draws as itself', async () => {
    mountScene('icon-set', 'icon-set')
    await expect.element(page.getByTestId('icon-set')).toMatchScreenshot('icon-set')
  })

  // The two LOOK goldens. Everything above pins CRISP geometry, so an edit to
  // sketch's jitter or neon's blur moved no committed pixel and the whole
  // look layer was judged by nothing. Each draws the SAME canvas on the
  // theme's own paper, since a halo on the wrong ground says nothing.
  it('sketch look: jittered outlines, a hatched preset node, a dashed frame', async () => {
    mountScene('sketch-look', 'sketch-look')
    await expect.element(page.getByTestId('sketch-look')).toMatchScreenshot('sketch-look')
  })

  it('neon look: a halo of each element’s own paint over crisp geometry', async () => {
    mountScene('neon-look', 'neon-look')
    await expect.element(page.getByTestId('neon-look')).toMatchScreenshot('neon-look')
  })
})
