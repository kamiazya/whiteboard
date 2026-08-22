# Whiteboard brand system

Companion to [DESIGN.md](./DESIGN.md) (in-app chrome). This file governs the
brand surfaces around the app: the mark, the splash, the tab icon, the
installable icons, the README hero, and link-share cards. Everything here
describes what is SHIPPED — update this file in the same increment as any
brand-surface change.

## The mark

The signature is a single pen squiggle:

```text
M20 44 C 27 22, 37 22, 44 33 S 58 50, 68 25   (in an 88x66 box)
```

Every brand surface renders this exact path. Two optional companions exist,
and each appears only where it earns its keep:

- **The board frame** (rounded rect, the whiteboard the squiggle sits on) —
  a *container*. It appears only where the mark needs containment, and it
  carries meaning where it does (see the favicon's offline grammar).
- **The wordmark** ("Whiteboard" in system-ui) — a *caption*. It appears
  only in document contexts where the name is not already present in the
  surrounding chrome.

### Surface matrix

| Surface | Frame | Wordmark | Why | Asset |
| --- | --- | --- | --- | --- |
| Boot splash | no | no | The viewport IS the board (a frame would double-box the mark inside the bezel); the name already lives in the tab title and the OS's own PWA splash | `public/boot-splash.svg` |
| Favicon | yes | no | The frame is functional: it breaks into dashes when offline and contains the minimap | `public/favicon.svg` (static) + `src/lib/favicon.ts` (dynamic) |
| PWA launcher icon | no | no | At launcher size, inside a mask, the frame only costs stroke weight and safe-zone space | `public/icon-192.png`, `public/icon-512.png` |
| README hero | yes | yes | A document context: the image needs containment to read as an object | `docs/assets/readme-mark.svg` (repo root `docs/`) |
| OG / social card | yes | yes | Same document logic, plus the card must carry the name on foreign surfaces | `public/og-image.png` |
| Onboarding chooser (empty workspace) | no | yes | The first page arrivals meet; the viewport is the board (no frame), and the name is not in the surrounding chrome, so the lockup introduces the product. The mark performs its one-shot draw (wb-scribble) | `src/brand/welcome-mark.svg` (SVGR) |

The rule in one line: **the squiggle is the signature everywhere; the frame
appears only where a container earns its keep; the wordmark only where the
name is not already on screen.**

## Color

Brand surfaces are mid-gray on any ground, plus exactly one accent:

- **Marks**: `#909090` ink, `#9ca3af` at ~55–62% opacity for frames. Chosen
  to read on both light and dark grounds, because several surfaces render
  inside `<img>` where the page theme cannot reach.
- **The blue spark `#3b6ecc` is the AI's hand** — the only *accent* on any
  brand surface. It appears when the AI acts (the tidy phase of the splash
  story, the spark on the OG card). Do not use it decoratively; its meaning
  is the point.
- **Status colors** (favicon dot): green `#16a34a` saved / amber `#d97706`
  unsaved / blue `#3b6ecc` syncing / gray + **dashed frame** + faded mark =
  offline. These are *state* colors, not accents; the syncing dot reuses
  the spark's hue deliberately — "the system is at work" is the same
  semantic family as the AI acting. The dashed frame is the load-bearing
  metaphor: the frame is the connection, and offline breaks it. Legible
  even at 16px.

In-app chrome state colors are DESIGN.md's domain and use a different
palette (emerald/amber on the connection chip — picked against chrome
surfaces, not a 16px tab strip). What the favicon mirrors is the header's
*signals* (`useDirtyState`, sync status), never its exact colors, so tab
and header always agree on state even where their palettes differ.

## Motion grammar

The splash (`public/boot-splash.svg`) tells the product story in one
self-contained SVG — CSS animation inside the file, no JS, renders inside
`<img>`:

1. The signature squiggle draws itself (1.2s) — all a fast load ever shows.
2. A beat, then it fades; a cursor sketches nodes and edges on the screen.
3. The spark (the AI's hand) tidies them into an aligned diagram.
4. The diagram bows out; the squiggle returns softly and breathes (3.2s
   cycle). Wherever the wait ends, it lands on the logo.

Rules the grammar enforces:

- **Draw once, never loop the draw.** A standing redraw loop reads as noise
  (the README hero taught us this). The only infinite animation is the
  breathe.
- **The splash is paced, not raced.** `src/boot-splash.ts` holds the splash
  to 1.5s from first paint (completed stroke + a beat) and fades it out
  (200ms) before React's first commit; reduced-motion users skip both.
- **Dash-revealed elements start at `opacity: 0`** and flip visible exactly
  when their draw begins — at full `stroke-dashoffset` some renderers still
  paint a seam dot at the dash boundary (stray specks on Android Chrome).
- **`prefers-reduced-motion` collapses every brand animation to the static
  drawn logo** — never a blank board, never a mid-story frame.
- **The inline loader** (`src/brand/loader-mark.svg` + `SquiggleLoader`) is
  a dash travelling along the signature over a faint full-path track — the
  ring-spinner grammar on the brand's own shape. Use it at 20px+ only;
  below that the travel collapses into flicker, so tiny affordances keep a
  plain ring.
- Skeletons in the app (DESIGN.md's domain) stay invisible for a 300ms beat
  and fade in only when the wait is real — a placeholder that pops for one
  frame reads as a glitch, not progress.
- **Celebration** (`src/lib/celebrate.ts`): a one-shot confetti burst in the
  brand palette (blue spark first) marks a setup step completing — persistent
  storage granted, the app installed. It fires only when the step completes
  live, never because a page opened on an already-complete step, never on a
  loop, and `disableForReducedMotion` suppresses it entirely. The burst
  originates at the completed step's badge so the celebration reads as
  belonging to the achievement, not the page.

## Browser and OS chrome

- `theme_color` (manifest) and the per-scheme `<meta name="theme-color">`
  pair in `index.html` follow the app ground: `#ffffff` light, `#0b0b0b`
  dark. No color the app itself never paints.
- Link previews come from the OG/Twitter metas in `index.html`, pointing at
  the hosted `og-image.png` (absolute URL). The GitHub repo's Social
  preview (Settings → Social preview) is a manual upload of the same file —
  the API cannot set it.

### In-app marks: SVGR

Marks rendered inside the React app live as plain `.svg` files under
`src/brand/` and are imported as components via vite-plugin-svgr
(`import Mark from '../brand/error-mark.svg?react'`). One file is both the
artwork's source of truth and a themable component: strokes use
`currentColor`, so the call site picks the token (`text-muted-foreground`,
`/30` for watermarks). Animation classes (e.g. `wb-scribble`) stay in
`index.css` — an inlined `<style>` would collide across instances.
Standalone assets (splash, favicon, README, OG/PWA generators) are NOT
SVGR: they render outside the app where no theme exists, so they stay
self-contained files with fixed mid-grays.

## Asset inventory and regeneration

All commands run from `apps/web/`.

| Asset | Source of truth | Regenerate |
| --- | --- | --- |
| in-app marks (error / not-found / welcome / home) | `src/brand/*.svg`, imported as React components via SVGR (`?react`) | edit the .svg directly |
| ALPHA chip (AppShell) | `src/components/AppShell.tsx` — amber chip + honesty popover; the durable home of "data durability is not guaranteed" | code |
| `public/boot-splash.svg` | hand-authored (this is the source) | edit directly; contract tests pin its grammar |
| `docs/assets/readme-mark.svg` | hand-authored framed+captioned variant | edit directly |
| `public/favicon.svg` | hand-authored static fallback | edit directly |
| dynamic favicon | `src/lib/favicon.ts` (+ `src/hooks/useFavicon.ts`) | code; style user-selectable in Settings → Appearance |
| `public/icon-192.png` / `icon-512.png` | `scripts/generate-pwa-icons.mjs` | `node scripts/generate-pwa-icons.mjs` |
| `public/og-image.png` | `scripts/generate-og-image.mjs` | `node scripts/generate-og-image.mjs` |
| README / docs screenshots | `src/docs-snapshots/**/*.docs-snapshot.test.tsx` + hand-authored `docs/assets/*.canvas` | `pnpm docs:snapshots` (run twice; commit the second run) |

## Contract tests (the grammar, pinned)

- `index-html.test.ts` — splash is icon-only (no `<text>`, no frame rect),
  draw-once / breathe-infinite animation names, reduced-motion `animation:
  none`, dash-reveal hidden until draw, self-contained SVG (no external
  refs), OG/Twitter metas, per-scheme theme-color, meta description.
- `pwa-icons.test.ts` — PNG dimensions match the manifest's declared sizes
  and the OG card is 1200×630.
- `vite-pwa-options.test.ts` — manifest `theme_color` matches the app
  ground.
- `src/lib/favicon.test.ts` + `favicon.browser.test.tsx` — minimap
  projection (delegating to the spatial editor's own minimap geometry),
  status mappings, hex-color validation, per-status pixel distinctness.
- `src/hooks/useFavicon.test.ts` — the dynamic favicon exists only while a
  canvas page is mounted; every other surface gets the static icon back.
