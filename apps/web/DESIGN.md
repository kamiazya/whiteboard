# apps/web design system

Direction: **quiet tool** (Linear/Figma lineage). The canvas content is the
only hero; chrome recedes.
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

## Canvas theme boundary

Canvas rendering (nodes/edges/selection) is themed by canvas-render's
`createSpatialTheme` — a separate authority that shares this document's
direction. The editor UI must not restyle scene SVG output directly; export
bytes never depend on the app's ambient UI theme.
