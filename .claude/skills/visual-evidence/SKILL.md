---
name: visual-evidence
description: Produce a before/after figure for a rendering change in this repo — render both versions through the real canvas-render pipeline, compose them side by side, and attach the PNG to the PR. Use whenever a change moves pixels (edge routing, layout, theme, SVG backend) and AGENTS.md's PR Visual Evidence rule applies.
---

# Before/after figures for a rendering change

AGENTS.md requires visual evidence on a PR whose change has a user-visible
effect. For a routing or layout change that means: the same canvas, rendered
by the code before and after, side by side. A reviewer should see the defect
and the fix without cloning anything.

The whole thing is four steps and about five minutes. The traps below are the
ones that actually cost time — every one of them has produced a wrong or
misleading figure at least once.

## 1. Pick a case the change actually fixes

**Do not eyeball this.** A canvas can look wrong for several reasons at once,
and the biggest offender is usually not the one you fixed — twice, a case
picked by "worst total ink" turned out to be dominated by a defect class the
change did not touch, and the figure showed the same flaw on both sides.

Select by the metric the change targets, and require it to go to zero:

```ts
// throwaway test: score every corpus case before and after, keep the ones
// this change actually repaired
const fixed = Object.keys(before).filter((name) => before[name] > 0 && after[name] === 0)
```

Run it once with the change, once with it stashed, and diff the two maps.
Prefer the smallest case in the list — three nodes reads; eight does not.

## 2. Render both versions through the real pipeline

A throwaway test, because the pipeline needs a measurer and a body parser
that only the test-utils have. Write to a path from the environment so one
file serves both runs:

```ts
// packages/canvas-render/src/layout/__render.test.ts  (delete when done)
import { writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { renderSceneToSvg } from '../svg/backend.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

it('render', () => {
  const scene = layoutSpatialCanvas(canvas, {
    measure: createFakeMeasure(),
    parseBody: (text) => ({ type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }] }),
    appearance: {
      resolveNode: () => ({ fill: '#ffffff', stroke: '#404040' }),
      resolveEdge: () => ({ stroke: '#d04040' }),
      resolveLabel: () => ({ fill: '#303030', fontFamily: 'sans-serif' }),
    },
    geometry: { paddingPx: 8, labelFontSizePx: 12, minContentWidthPx: 1 },
  })
  writeFileSync(process.env.OUT as string, renderSceneToSvg(scene))
})
```

```bash
mkdir -p tmp/screenshots
OUT=$PWD/tmp/screenshots/after.svg  pnpm vitest run --project canvas-render-node __render
git stash push -q packages/canvas-render/src/layout/edges/spatial-edges.ts   # tracked files only
OUT=$PWD/tmp/screenshots/before.svg pnpm vitest run --project canvas-render-node __render
git stash pop -q
```

**Trap — `git stash push` on a path with nothing to stash silently succeeds**,
and `before.svg` comes out identical to `after.svg`. It happens when the
change is already committed, or when you name an untracked file. Symptoms:
the two files are the same size and the figure shows no difference.

- change still uncommitted → `git stash push -q <tracked file>`
- change already committed → `git checkout HEAD~N -- <file>`, then
  `git checkout HEAD -- <file>` to restore
- **always** `grep -oE '<polyline points="[^"]*"' before.svg after.svg` and
  confirm the paths actually differ before building the image

**Trap — a `git checkout` to restore also reverts edits you have not
committed.** Re-apply them, and check with `git status` before moving on.

## 3. Compose the two panels

The serializer emits no `fill` on `<rect>` (appearance is assigned, not
invented), and ImageMagick renders an unfilled rect **black**. Inject fills
while splicing:

```python
def body(p):
    s = open(p).read()
    s = s[s.index('>') + 1 : s.rindex('</svg>')]          # strip the root element
    return s.replace('<rect ', '<rect fill="#ffffff" stroke="#404040" stroke-width="2" ')

def panel(inner, dx, title, color):
    return (f'<g transform="translate({dx},72) translate(-X,-Y)">{inner}</g>'
            f'<text x="{dx+20}" y="44" font-family="sans-serif" font-size="21" '
            f'font-weight="bold" fill="{color}">{title}</text>')
```

`translate(-X,-Y)` pulls the scene's top-left corner to the panel origin —
read X/Y off the smallest node coordinates in the canvas. Title the panels
with the *finding*, not the mechanism: "before — 170px through B" beats
"before — tier order". Red `#c0392b` for before, green `#1e8449` for after.

```bash
convert -density 150 tmp/screenshots/figure.svg tmp/screenshots/figure.png
```

**Trap — ImageMagick is not an SVG renderer, and fails by DROPPING things.**
It ignores `fill-opacity` (a 12%-alpha code panel painted as a solid slab of
the full colour) and it can drop `<text>` outright, reporting only
`non-conforming drawing primitive definition 'SF'` on stderr — which reads
like a warning and is actually "your figure has no words in it". Both were
observed on one markdown-body figure whose SVG was verified correct by
grepping its own `fill=` attributes. Anything relying on alpha or on text
must go through **resvg**, the renderer the product itself uses:

```bash
# from packages/mcp-server, where @resvg/resvg-js and the vendored faces live
node -e "…new Resvg(svg, {font:{fontFiles, loadSystemFonts:false, defaultFontFamily:'Roboto'}})…"
```

Keep ImageMagick for what it is good at — `-border`, `+append`, composing
finished PNGs side by side.

**Trap — resvg only has the vendored Roboto** (ADR-0011), so a figure about
anything the browser renders differently (a mono face, a CJK script) is not
showing what a user sees. When the figure IS about that, render it in the
`web-browser` vitest project instead, where a real measurer and real system
fonts exist, and screenshot the DOM:

```ts
await page.screenshot({ path: '../../tmp/screenshots/figure.png', element: host })
```

Note the path: vite's `server.fs` refuses anything outside the project, so
`/tmp/...` fails with `Access denied` — write inside the repo.

**Trap — a synthetic measurer plus a real rasteriser is a lie.** A figure laid
out with `createFakeMeasure` (0.6em per character) and painted by resvg with
real Roboto metrics puts every glyph at coordinates computed for a font that
is not the one drawing it. It reads as bizarre extra spacing between runs and
looks like a layout bug in the code under test. Measure and paint with the
same face, or do not make the figure.

## 4. Look at it, then attach it

**Read the PNG before uploading.** Half the failures above are invisible in
the SVG text and obvious in the image.

```bash
gh image tmp/screenshots/figure.png     # prints the markdown
```

Paste under a `## Visual repro` heading with one sentence naming what to look
at. Delete the throwaway test and the intermediate `.svg` files; keep the PNG
in `tmp/screenshots/` until the PR merges (the GitHub upload is the durable
copy).

## When a figure is the wrong evidence

If the change is invisible to a human — a schema, an internal helper, a pure
optimisation — do not manufacture a picture. For an optimisation, the honest
evidence is an aggregate that did NOT move plus a benchmark that did; see the
`measured-change` skill.
