# ADR-0011: Fonts are installed by whoever needs them, not bundled

**Status:** Accepted

## Context

The export path draws with four vendored Roboto faces and nothing else. resvg is
given their paths with `loadSystemFonts: false`, deliberately — the system-font
scan dominates first-call latency, and no other family appears in the SVG
`canvas-render` produces.

**With one existing exception**, which decision 5 below makes explicit: when the
vendored Regular face cannot be resolved at all, `headless-renderer.ts` falls
back to `{ loadSystemFonts: true }` and logs a warning. That branch is a
last-resort degradation, not the normal path, and it is the one place today
where host fonts can change exported pixels.

Roboto is Latin-only. resvg does not substitute a face it was not given. So a
Japanese canvas exports as tofu boxes:

| | |
|---|---|
| `Hello world` | renders |
| `こんにちは世界` | □□□□□□□ |

**The measurement is already right**, which is what makes this worth an ADR
rather than a bug fix. `createOpentypeMeasureText` falls back to the
constant-ratio estimator per code point for anything the face lacks, so the box
is the right size, the text wraps in the right places, and `truncated`,
`overflows` and the digest all report a healthy render. Layout is correct and
the reader cannot read it.

Three constraints shape the answer, and each has already rejected an obvious fix
elsewhere in this repo:

- **Offline.** The widget smoke asserts that rendering triggers **no network
  fetch at all**. The export path is likewise local-only.
- **Byte-identical output.** `canvas-render`'s headline guarantee is that the
  same scene renders identically on Node, in the browser and on Workers.
- **Package size.** The published `dist` is **5.2 MB**. Noto Sans CJK Regular
  alone is **18.6 MB** — bundling it makes the package 4.6x larger for every
  user, including everyone who never writes a non-Latin character.

## Decision

**Fonts beyond the Latin default are separate packages, installed by whoever
needs them.** The daemon resolves whatever is present and reports what it could
not draw.

### 1. The unit is a SCRIPT, not a language

A `lang-ja` and a `lang-ko` package would each carry the same CJK face, because
Noto CJK covers Japanese, Chinese and Korean in one file. Scripts are what fonts
are actually cut along. A language-shaped package, if one is ever wanted, is a
thin dependency declaration over script packages and carries no bytes of its own.

**Themes make this decisive rather than merely tidy.** A handwriting style is
not a language, and putting a handwritten face inside `lang-ja` is incoherent.
What the resolver keys off is the family the theme already names
(`SPATIAL_THEME_FONT_FAMILY`), so a font package is a **provider of faces** and
nothing more. That is one concept, not two, and it is the concept the theme
layer already has.

### 2. Line-breaking models are NOT part of this

Measured: the vendored BudouX Japanese model is **28 KB**, against 18.6 MB for
one CJK face — a factor of 650. Adding Chinese, Korean and Thai models would
cost about 100 KB in total.

So they stay bundled in `canvas-render`, and a script added later is one commit,
not a package. BudouX runs unchanged on Node, in the browser and in a Worker
(that is why it was adopted), the lazy-construction shape is already established,
and putting a resolution seam in front of 28 KB would buy wiring, failure paths
and a report for nothing. The vendoring itself is about a packaging accident in
budoux's entry point, not about portability — see
`packages/canvas-render/src/vendor/budoux/README.md`.

### 3. The resolved font set is part of the render contract, and is reported

This is the price of the decision and is not optional. Once output depends on
what is installed, "which fonts were used" is as much a part of the answer as
the pixels. Silent variation by ambient state is the exact failure class this
repo keeps paying for.

The first half already exists: an export reports `undrawable`, the characters
its own fonts have no glyph for, and logs a warning when that list is non-empty.
Absence of a font is a **declared degradation**, not a broken render.

### 4. Measurement and painting resolve the SAME set

A font used to measure but not to paint (or the reverse) makes every derived
signal a claim about nothing — `overflows` in particular, which asserts what a
reader sees. `ServerDeps.measure` is the existing seam and both sides go through
it. A future provider registry supplies faces to that seam and to resvg from one
place, never two.

### 5. The whole-font fallback is a declared exception, and stays one

`headless-renderer.ts` uses `{ loadSystemFonts: true }` when the vendored
Regular face is unresolvable. It contradicts decision 3's reproducibility
requirement, and it is kept anyway: the alternative is an export that fails
outright because an asset is missing from a packaging accident, which is worse
for the user than a render that is legible but not byte-reproducible. It logs a
warning, which is what keeps it from being silent.

Two bounds on it:

- **It is per-install, not per-canvas.** The condition is "this deployment has
  no vendored font", not "this text needs a glyph". A working install never
  reaches it.
- **`undrawable` reports `[]` in that branch**, because nothing was measured
  against a known face — the same rule as `overflows`, where absence means NOT
  MEASURED rather than "fine". Reporting every character as undrawable there
  would be a louder and wronger answer than reporting nothing.

Making the renderer fail closed instead is a real option and deliberately not
taken here; it is a behaviour change for a condition nobody has hit, and this
ADR is about distribution.

### 6. Licensing follows the Roboto precedent

`assets/fonts/Roboto/LICENSE.txt` sits beside the files, and root `NOTICE` names
the font, its authors, its license and where the full text lives. Any font
package repeats exactly that.

One difference to plan for: Roboto is Apache-2.0, and the Noto CJK faces are
**OFL 1.1**. Under OFL a **subset is a modification**, so a subsetted face
cannot keep a Reserved Font Name. Check the specific face's RFN before
subsetting, or ship it whole. An Apache-2.0 alternative (Droid Sans Fallback,
3.8 MB) avoids the question at some cost in coverage and quality — a per-package
choice, not a project-wide one.

## Alternatives rejected

**Bundle a CJK face in `@kamiazya/whiteboard-mcp`.** 5.2 MB → 23.8 MB for every
user, most of whom never need it. Rejected on the measurement.

**`loadSystemFonts: true` as the ANSWER for missing scripts.** One line, and it
makes output depend on the host's installed fonts — the same canvas renders
differently on two machines, which is precisely the guarantee `canvas-render`
exists to make. Rejected as a solution; it survives only as the last-resort
branch described in decision 5, on a condition a working install never meets.

**Download at startup or on first render.** Breaks the offline property the
widget smoke asserts, makes output depend on when the download succeeded, and
fails behind corporate proxies. npm already solves distribution, caching,
offline install and version pinning; a bespoke downloader would re-implement all
four worse.

**Embed the font in the SVG as `@font-face`, or hand resvg a buffer.**
Not possible. `@resvg/resvg-js@2.6.2` accepts `fontFiles` and `fontDirs` only —
there is no `fontBuffers` option and no CSS font loading, so an embedded
`@font-face` or `data:` URI is ignored. Verified against the installed type
definitions. Note this is a limitation of the rasteriser, not of "web fonts": the
bytes a web font is made of work fine, they just have to reach resvg as a **file
path**, which is what a font package provides.

## Consequences

- A Japanese PNG export is tofu until a CJK font package is installed, and the
  render says so rather than pretending. Editor and SVG output are unaffected —
  the browser has its own fonts, and SVG keeps the characters as `<text>`.
- Adding a script to the line breaker stays a one-commit change.
- CI installs a small `:lang=ja` face through apt for `widget-smoke`; that is a
  runner concern and deliberately not the distribution mechanism.
- The provider registry is not built yet. Until it is, a deployment that needs
  CJK export can pass font paths to resvg directly — this ADR fixes what the
  eventual mechanism must satisfy, not its API.
