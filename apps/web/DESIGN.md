# apps/web design system

Direction: **quiet tool** (Linear/Figma lineage). The canvas content is the
only hero; chrome recedes.
Brand surfaces around the app (mark, splash, favicon, icons, social cards)
are governed by [BRAND.md](./BRAND.md).
Hierarchy comes from surfaces and whitespace, not boxes. Accent color carries
**state meaning only** — never decoration.

## Tokens

All tokens live in `src/index.css` as CSS custom properties (oklch), mapped
into Tailwind v4 via `@theme inline`. Light values on `:root`, dark on
`.dark`. Do not hardcode palette values in components; if a component needs a
color the tokens cannot express, that is a token-system change, not an inline
value.

| Token | Role |
| --- | --- |
| `--background` / `--foreground` | page surface and its text |
| `--card`, `--popover` (+`-foreground`) | raised surfaces (cards, menus, popovers) |
| `--primary` (+`-foreground`) | the one emphasized action per view |
| `--secondary`, `--muted`, `--accent` (+`-foreground`) | quiet fills, de-emphasized text, hover fills |
| `--destructive` | irreversible actions and error text ONLY |
| `--border`, `--input`, `--ring` | hairlines, input outlines, focus rings |
| `--radius` (sm/md/lg/xl derived) | one radius scale — never ad-hoc radii |

State colors outside the shadcn set (used by `ConnectionStatus`):
`emerald-500` = live/synced, `amber-500` = needs attention,
`muted-foreground` = neutral/local. These are the ONLY approved uses of raw
Tailwind palette colors in chrome.

## Rules

- **Borders are quiet by default.** `src/index.css` restores the token
  border color for every element (Tailwind v4 makes bare `border`
  currentColor otherwise — the source of the pre-refactor "black box" look).
  Use bare `border`; add `border-<color>` only when the border itself
  carries state.
- **One accent per view** (baseline-ui): destructive red on at most the one
  destructive control; the connection chip is the only stateful color in a
  header.
- **Buttons**: use `components/ui/button.tsx` variants
  (`default`/`outline`/`ghost`/`destructive`, sizes `sm`/`icon`) instead of
  hand-rolled `rounded-md border px-*` buttons. Icon-only buttons MUST have
  an `aria-label`.
- **Sentence-length copy never sits in chrome.** Explanations live in
  popovers/tooltips/dialogs (see `ConnectionStatus`); chrome carries words
  only as short labels ("Saved", "Local").
- **Dialogs**: `max-h` + `overflow-y-auto` when content can grow; page-width
  cards must wrap (`min-w-0`, `break-all` for unbreakable strings) before
  entering a dialog.
- **Raw identifiers are not chrome.** Ids appear in detail surfaces only;
  single-choice selectors (one workspace) render nothing at all.
- **Both themes always.** Any new color must be defined for `:root` and
  `.dark`, and respect the WCAG 1.4.3/1.4.11 floors the contrast tests pin.
- **Motion**: every animation must serve hierarchy, feedback, or
  continuity — if it serves none, delete it. Compositor props only
  (`transform`, `opacity`). Use the motion tokens from `src/index.css`
  instead of ad-hoc numbers: `--motion-duration-fast` (150ms,
  hover/press feedback), `--motion-duration-normal` (220ms, state
  changes and small surfaces like popovers/toasts),
  `--motion-ease-out` (soft ease-out — never bouncy in chrome).
  Entrances are fade + small rise/scale (0.98→1); no entrance animation
  without an explicit reason. `prefers-reduced-motion` is enforced
  globally by the base-layer guard in `src/index.css` — component code
  must not assume an animation ran (never gate logic on motion).

## Bottom chrome: one dock, fixed width

All bottom-anchored canvas chrome lives in ONE flex container (the tool
palette dock). Host controls (undo/redo/version history) join it through
`SpatialEditor`'s `paletteLeading` slot — never as an independently
positioned floating island, because independent islands collide as tools
grow (the 2026-08-08 phone overlap).

The dock's button set is FIXED and small ([history | select/connect | +]):
creation tools live in the "+" menu (the tldraw/FigJam shape, user
decision 2026-08-08), so the dock stays a single row at any viewport and
a new node type extends the menu, never the dock's width. Wrapping and
overflow-scrolling are both rejected: wrapping stacks rows as tools grow,
and scrolling clips popovers anchored inside the dock (version history,
the + menu). Opening the + menu focuses its first entry (keyboard path:
Enter, Enter).

## Keyboard shortcuts: one catalog

Every editor keyboard binding is declared in
`src/components/spatial-editor/shortcuts.ts` (user decision 2026-08-09) —
ids, combos, display strings, and mode scoping in one table. New
shortcuts are added there and dispatched by `handleKeyDown`'s table
lookup; an ad-hoc `e.key === …` branch in a component is the drift this
catalog exists to prevent. Bindings that predate the table are declared
with `handledInline: true` so the catalog stays complete while their
bespoke branches migrate over time.

Z-order uses the tldraw combos: `]` / `[` step forward/backward,
`Shift+]` / `Shift+[` go to front/back — matched on `KeyboardEvent.code`
(physical bracket keys, layout-stable). Every keyboard action that
mutates the canvas also has a touch path (the context menu's Order row,
here) — a shortcut is an accelerator, never the only way.

Bindings today: `Cmd/Ctrl+A` select all, `Cmd/Ctrl+C/X/V` copy/cut/paste,
`Cmd/Ctrl+D` duplicate, `]`/`[`/`Shift+]`/`Shift+[` z-order,
`Shift+1`/`Shift+2` zoom to fit / to selection, plus the inline-handled
Delete / Esc / Space-pan / arrows.

The clipboard family (`Cmd+C/X/V`) is declared in the catalog but
`handledInline` on purpose: it rides the NATIVE copy/cut/paste DOM
events, because a keydown `preventDefault` on the chord suppresses the
very event carrying `clipboardData` — the payload that crosses tabs and
that lets foreign text degrade into a note. Paste follows a content
cascade (image file → our `whiteboard/clipboard` JSON → any other text
as a note → in-app slot fallback).

Modifier policy: a spec claims the platform command chord with
`mod: true` (Cmd on macOS or Ctrl elsewhere — either satisfies it) and
Alt with `alt: true`; a held modifier suppresses every spec that does
not claim it, so browser combos stay the browser's until a catalog
entry explicitly takes one. Command chords still never fire from a
text-entry surface.

## Canvas theme boundary

Canvas rendering (nodes/edges/selection) is themed by canvas-render's
`createSpatialTheme` — a separate authority that shares this document's
direction. The editor UI must not restyle scene SVG output directly; export
bytes never depend on the app's ambient UI theme.

### Preset colors ('1'..'6')

JSON Canvas preset colors are semantic slots stored in the data, resolved
to concrete paint by the theme palette (`SpatialPalette.presets` in
canvas-render) — swappable data, never hardcoded in resolver code. Per
mode the accents are: light = Tailwind 600 strokes over 100-tint fills,
dark = 400 strokes over 950-tint fills. Nodes render accent stroke +
tint fill (text keeps the theme's text color); edges render the accent
as stroke. Floors are pinned by tests, not exact hexes: preset strokes
hold ≥3:1 against the mode background, and label text holds ≥4.5:1
against the tint fill — a replacement palette must keep passing both.
The editor's Color row previews swatches from the CURRENT mode's palette
strokes, while the stored value stays the slot key.
