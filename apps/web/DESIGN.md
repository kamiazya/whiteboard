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

State colors outside the shadcn set live in ONE component,
`components/StateDot.tsx`, which every chrome state carrier draws from:
`emerald-500` = safe (saved, synced), `amber-500` = needs attention,
`muted-foreground` = neutral/local. These are the ONLY approved uses of raw
Tailwind palette colors in chrome, and a carrier picks a MEANING (`tone`)
rather than a color. It also picks a SHAPE, which is what separates two
carriers that share a tone: `filled` is a state the document is IN, `ring`
one it is not in yet, `spinner` that same ring while the doing is in flight.

## Rules

- **Borders are quiet by default.** `src/index.css` restores the token
  border color for every element (Tailwind v4 makes bare `border`
  currentColor otherwise — the source of the pre-refactor "black box" look).
  Use bare `border`; add `border-<color>` only when the border itself
  carries state.
- **One accent per view** (baseline-ui): destructive red on at most the one
  destructive control. Stateful color in a header is limited to a closed,
  named set, and each member says what QUESTION it answers — two carriers
  that look alike but answer differently is the defect this naming exists to
  prevent:
  - **connection chip** (`ConnectionStatus`) — is this browser reaching its
    backend? Filled dot. It lives in the AppShell, not in a page.
  - **save-state chip** (`SaveStatusChip`) — did the last write to this
    browser's storage land? Filled dot. Browser-local only; on a daemon the
    connection chip is what answers "is my work safe", and a second dot
    saying so would be the same fact twice.
  - **version dot** (`HeaderVersionDot`) — are there edits no named version
    holds yet? RING, not filled, precisely because it shares the amber tone
    with the save-state chip while asking something else. It carried the
    filled amber and the name "save dot" until 2026-08-22, which made one
    shape mean two things depending on the mode.
  - **AppShell gear's attention dot** — brand blue, actionable-todo only.

  Anything else stateful in chrome needs this list amended first, and takes
  its paint from `StateDot` rather than a fresh literal.
- **The AppShell owns brand, connection and settings.** Every page mounts
  `AppShell` (brand mark = home, the ALPHA honesty chip, the connection chip,
  the settings gear + attention dot) and never renders its own brand,
  connection or settings chrome. Context and tools stay in the page's own
  surface, always visible — collapsing them into menus is a narrow-viewport
  last resort, not a desktop pattern. Where BRAND.md (identity, motion) and
  this file (app chrome) disagree about chrome, this file wins and the
  exception gets documented here.
- **What belongs in the shell is what does not change when you open a
  different document.** Which daemon this browser talks to is one such fact,
  so the connection chip is the shell's; the document's own title, actions
  and history are the page's. The dividing question is not importance, it is
  whether the answer survives navigation.
- **The shell states a connection only while a page holds one.** Pages report
  through `lib/shell-status-store`, and `null` — an index or settings page —
  draws no chip at all. A daemon index page does talk to the daemon over
  HTTP but runs no document sync, so neither "Synced" nor "Reconnecting" is
  true there, and a chip that stayed behind from the last document would say
  one of them anyway. Clear on unmount; never latch.
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

## Object-action surfaces are icon-first

The palette's "+" menu keeps icon AND label on every entry: a creation
menu is a first-contact reading surface, and ToolPalette says so in its
header comment. That principle is deliberately NOT extended to
object-action surfaces (the selection's ⋯ popover, and by extension any
future action sheet): there the verbs render icon-only, in a grid of
44px targets, with the name carried by `aria-label` (non-negotiable —
"no visible text" is a visual statement only) and a `title` tooltip on
desktop. Rationale: object verbs are conventional symbols (edit, delete,
lock, open) recovered in one hover/press, misfires inside the menu are
one Undo away, and the grid keeps every verb visible at once instead of
scrolling a list. The Copy/Cut/Duplicate trio ships icon-only first; if
dogfooding observes misfires, labels return by observation, not by
guess.

Both vessels — the right-click list menu and the ⋯ grid — draw the SAME
catalog in the SAME band order: property rows (color, z-order, arrows;
the menu stays open), then verbs (one-shot; the menu closes), then the
destructive entry alone at the bottom. What is learned in one vessel
must transfer to the other, so a new action is added to the catalog,
never to a single vessel.

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
