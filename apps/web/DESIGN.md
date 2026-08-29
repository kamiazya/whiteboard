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
  - **the shell mark** (`ShellMark`, triggered through `ConnectionStatus`) —
    who keeps this workspace, and is the session reaching it? A filled dot on
    the signature's own end point. It lives in the AppShell, not in a page,
    and it REPLACED a labelled chip at the far right of the row: a keeper and
    a session are facts about the workspace, so they belong on the thing that
    stands for it. Those are still two questions in one carrier and the split
    is still open — `browser` names the KEEPER (and survives navigation),
    while `synced`/`reconnecting`/`sync-off` report a live session (and do
    not). Merging the carriers did not resolve that; it put the unresolved
    pair in one place instead of implying two subjects.

    This is the one carrier with a SECOND channel, and it is not decoration.
    `reconnecting` and `sync-off` are both `attention`, and the chip's WORD
    was what separated them for a sighted reader. A 26×16 signature has no
    room for a word, so MOTION does it: reconnecting travels (`wb-loader` —
    the loader mark's own dash, on the same path), sync-off sits broken and
    dimmed. The word moves to the accessible name and the popover's header,
    where assistive tech reads it either way.

    Two gestures, both finite, one per direction. `sync-off` arriving keeps
    the chip's attention echo verbatim. `reconnecting`/`sync-off` → `synced`
    plays a recovery draw — the RARE moment, not the routine one. There is
    deliberately no "a write landed" celebration: the daemon keeper has no
    write-landed signal to hang one on (its `session` is derived from
    transport liveness, not from an ack), so shipping it would light up for
    browser-kept workspaces only and read as "the daemon is not saving" —
    which is exactly what "never offer what the keeper cannot honour" below
    forbids.
  - **save-state chip** (`SaveStatusChip`) — did the last write to this
    browser's storage land? Filled dot. Browser keeper only; on a daemon the
    shell mark is what answers "is my work safe", and a second dot saying so
    would be the same fact twice.
  - **version dot** (`HeaderVersionDot`) — are there edits no named version
    holds yet? RING, not filled, precisely because it shares the amber tone
    with the save-state chip while asking something else. It carried the
    filled amber and the name "save dot" until 2026-08-22, which made one
    shape mean two things depending on the mode.
  - **AppShell gear's attention dot** — brand blue, actionable-todo only.

  Anything else stateful in chrome needs this list amended first, and takes
  its paint from `StateDot` rather than a fresh literal.
- **The AppShell owns brand, connection and settings.** Every page mounts
  `AppShell` (the signature mark, the ALPHA honesty chip, the settings gear +
  attention dot) and never renders its own brand, connection or settings
  chrome.

  The row reads in two halves, and the spacer is the divider: **left of it is
  what you are working IN** (the mark = this workspace), **right of it is the
  app and its own state** (the alpha stage, settings). Position is what tells
  a reader which layer a control belongs to, since chrome carries no
  sentence-length copy to say so — and it is why the connection carrier moved
  onto the mark rather than staying at the far right.

  The mark's click changed with it: with a live session it opens the
  connection popover, and Home is the last item there rather than the click
  itself. With NO session published there is nothing to explain, so the mark
  stays a plain link home — the popover appears exactly when it has something
  to say.

  Context and tools stay in the page's own surface, always visible —
  collapsing them into menus is a narrow-viewport
  last resort, not a desktop pattern. Where BRAND.md (identity, motion) and
  this file (app chrome) disagree about chrome, this file wins and the
  exception gets documented here.
- **What belongs in the shell is what does not change when you open a
  different document.** Which workspace you are in, and who keeps it, are
  such facts, so the mark and the workspace switcher beside it are the
  shell's; the document's own title, actions and history are the page's. The
  dividing question is not importance, it is whether the answer survives
  navigation.
- **The switcher reads the address; it never holds a second opinion about
  it.** `WorkspaceSwitcher` takes the workspace it names from
  `parseWorkspaceRoute(location.pathname)`, because the workspace is the
  outermost layer of `/w/:workspace/d/:path` and the URL is what decides
  which one is active. That is also why it sits in the shell rather than on
  the document list: the layer is present on every page, and a control
  reachable only from the list could not change it from a document.

  Until the list of workspaces answers, the trigger shows the handle the
  address carries. A handle is a true statement about where you are, and a
  blank or a spinner in a 40px row is not an improvement on one.

  It is shown even when there is exactly one workspace. That is the
  difference between a switcher and a filter: the daemon list control it
  replaced hid itself below two, which is right for narrowing rows and wrong
  for the only door out of one workspace.

  What it OFFERS follows the keeper. Creation and renaming appear only where
  the keeper can actually perform them — the browser mints and renames its
  own workspaces, the daemon publishes no write surface for them yet — which
  is the standing rule below applied to this control. Absent, not disabled: a
  disabled control says "not right now" about something that is not there at
  all. Renaming additionally waits for the list, because its form starts from
  the name and address the workspace HAS, and one pre-filled from a handle
  alone would offer to overwrite a display name it never read.

  **The name and the address are two fields, edited separately.** ADR-0019's
  middle layer is what every existing link to a workspace says, so deriving
  it from the display name would break those links each time somebody fixed a
  typo in the name. Only what the form actually changed is sent — an address
  field submitted unchanged would turn a name edit into an address write, and
  the address write is the one that can be refused for a collision. Moving
  the address moves the URL with it; a name-only rename navigates nowhere and
  the trigger re-reads its subject from what the rename answered.
- **The shell states a connection only while a page holds one.** Pages report
  through `lib/shell-status-store`, and `null` — an index or settings page —
  leaves the mark stateless (no dot at all). A daemon index page does talk to the daemon over
  HTTP but runs no document sync, so neither "Synced" nor "Reconnecting" is
  true there, and a chip that stayed behind from the last document would say
  one of them anyway. Clear on unmount; never latch.
- **Buttons**: use `components/ui/button.tsx` variants
  (`default`/`outline`/`ghost`/`destructive`, sizes `sm`/`icon`) instead of
  hand-rolled `rounded-md border px-*` buttons. Icon-only buttons MUST have
  an `aria-label`.
- **Sentence-length copy never sits in chrome.** Explanations live in
  popovers/tooltips/dialogs (see `ConnectionStatus`); chrome carries words
  only as short labels ("Saved", "Browser").
- **Never offer what the keeper cannot honour.** An affordance is a promise
  about what the app can do, and the keeper decides how far that reaches: a
  document kept in this browser is reachable from no other browser, so a
  "Copy link" there hands out an address nobody else can open. The same
  control was building its link from the document's PATH, so renaming also
  broke every link already handed out — it was removed rather than narrowed,
  because sharing has to be designed against the keeper that has to honour
  it. Before adding a control, ask which keepers can actually deliver it.
- **Status reports; Settings manages.** A surface that reports a state carries
  only what you cannot go looking for — a dropped sync is not something anyone
  seeks out, so its recovery (re-pair, work in the browser instead) stays in
  the popover of the mark that reports it. Changing which daemon this browser uses is the
  opposite: it has an intent behind it, so it lives in Settings and the
  popover only points there. The dividing question is whether the user would know to
  look.
- **Name the keeper, never the locality.** A workspace is kept by the
  **Browser** or by a **Daemon**; both are on the user's machine, so "Local"
  named neither and collided with "local daemon" in its own popover. See
  `.claude/rules/vocabulary.md`'s keeper section — including the line copy
  may now cross and the one it may not: the whole-workspace MOVE to a daemon
  is implemented (Settings > Connections, "This workspace"), but the browser
  does not become a replica afterwards, so copy promises the move and never a
  silent source-of-truth swap. Continuing from the daemon is a narrated
  reload the user takes.
- **Dialogs**: `max-h` + `overflow-y-auto` when content can grow; page-width
  cards must wrap (`min-w-0`, `break-all` for unbreakable strings) before
  entering a dialog.
- **Raw identifiers are not chrome.** Ids appear in detail surfaces only. A
  control that would have nothing but an id to show is the case to look at:
  two workspace selects rendered canonical ids as their own option labels
  before the switcher replaced them, and one of those was on the document
  page's header row. What a control falls back to when a name is missing is
  part of its design, not an afterthought — `workspaceLabel` is where that
  precedence lives.
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
