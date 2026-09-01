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
  such facts, so the mark is the shell's; the document's own title, actions
  and history are the page's. The dividing question is not importance, it is
  whether the answer survives navigation.
- **The mark IS the switcher, and the row does not name the workspace.** The
  strip is `[mark] ALPHA <spacer> gear` and nothing else. The mark states
  which workspace you are in through its ACCESSIBLE name
  (`Workspace: Design team — Synced`), and its popover is where that name is
  drawn, beside the session word. "Where does the workspace name appear at
  all?" was answered deliberately: the shell need not name it, and the
  document browser should, as its own heading — because the four places
  content cannot tell you (the index, settings, an empty workspace, and the
  moment after a switch) are exactly where a page heading is looking at you
  anyway.

  The popover reads head, then `Switch to`, then the workspaces (a tick on
  the current one, `aria-current` for anyone not reading ticks), then `New
  workspace`. It deliberately ends there. The mark's own source calls it
  "click = go home", and becoming a trigger amends that — but the amendment is
  that the mark stops being a destination, NOT that the popover gains one. A
  cross-workspace "all documents" entry would promise a state this product
  does not have, and the ways out already exist: `WorkspaceTopBar`'s back
  leaves a document, and every workspace is reachable from the list.

  It opens on EVERY page, including one holding no session. The workspace is
  a fact everywhere, so there is always something for the popover to say, and
  the older shape — a plain link home until a page published a session — would
  put the only door out of a workspace behind having opened a document first.

  What the popover reads FROM is the address: the workspace is the outermost
  layer of `/w/:workspace/d/:path`, and the URL is what decides which one is
  active. Until the rows load, the mark names the handle the address carries —
  a true statement about where you are, and better than a blank in an
  accessible name.

  The list is shown even at exactly one workspace. That is the difference
  between a switcher and a filter: the daemon list control it replaced hid
  itself below two, which is right for narrowing rows and wrong for the only
  door out of one workspace.

  What it OFFERS follows the keeper. Creation and renaming appear only where
  the keeper can honour them — the browser mints and renames its own, the
  daemon publishes no write surface for workspaces yet. Absent, not disabled:
  a disabled control says "not right now" about something that is not there at
  all. Renaming additionally waits for the rows, because its form starts from
  the name and URL the workspace HAS, and one pre-filled from a handle alone
  would offer to overwrite a display name it never read.

  **The head IS the editor — there is no rename form.** This repo already
  retired the pencil-menu rename for a document title you edit in place, and
  ADR-0006 says an object is "named in place afterwards"; a `Rename workspace`
  item would be that shape rebuilt one layer up. So the popover opens on the
  name in a box, with the URL directly beneath it, and no Save button
  anywhere. Where the keeper cannot write, both are `readOnly` rather than
  hidden — the name is the head, and hiding the subject to say "you cannot
  edit it" removes the subject.

  **The two fields commit differently, and the difference is the point.** The
  name commits on the keystroke, exactly as the document title does, and
  Escape writes the PREVIOUS name back because there is nothing left to
  discard. The URL waits for Enter or blur: committing it moves the address
  and navigates, so per-keystroke would move it once per character, through
  intermediate values that are real addresses and can collide. Escape there
  reverts the box without writing.

  The URL is drawn as the URL — a `/w/` prefix and the editable part — and
  carries no visible label. ADR-0019 calls the layer the `segment`, which is
  not a word to put in front of somebody, and every plainer substitute
  invents a FOURTH name for a layer that has three. The warning that old
  links will break appears only once the box actually differs from what is
  stored; permanently visible, it is furniture nobody reads.

  Each layer is written on its own, never as a form submitting both: an
  unchanged URL sent back would put every name edit behind the one write that
  can be refused for a collision.
- **A document's path is drawn as the URL too — but it keeps its label.** The
  create and rename forms put the head of the document's address in front of
  the box (`/w/<handle>/d/`), so the text a person types is visibly a URL and
  not a loose string. That head is sliced from `app-routes`' own builders,
  separators included: a literal written into the component would go on
  reading correctly long after the grammar moved, and a form that shows the
  wrong address confidently is worse than one showing none. With no handle
  yet resolved it shows nothing, because `/w//d/` is not half an address, it
  is a wrong one.

  What does NOT carry over from the switcher is dropping the label. There the
  whole popover is unlabelled and the layer's only name is `segment`, which is
  not a word to put in front of somebody. Here the form has two labelled
  fields, `Path` is the word ADR-0008 already uses, and stripping one label of
  the pair reads as breakage rather than as consistency. The prefix is added
  to what the field SAYS, not swapped in for it — and it is part of the
  field's accessible description rather than `aria-hidden`, since it is the
  only thing on the form stating that a path is an address.

  The handle is the one part allowed to truncate. A workspace with no segment
  is addressed by its 26-character canonical id, and that prefix measured
  269px of a 398px row — enough to push the dialog's form past its own max
  width and overflow on every viewport. Truncating the prefix as one string
  would eat `/d/` off the end, which is the half that says where the text
  lands; truncating only the handle keeps the grammar legible at any width.
- **The switcher is offered even when the address names no workspace.** A
  daemon holding nothing serves `/`, and the switcher is the only place
  creation lives — so requiring a handle before rendering it left a fresh
  daemon with no way to make its first workspace. With no handle the menu has
  no current row, which is already how it behaves for an address it cannot
  resolve: the rename section sits behind a resolved row, so what is left is a
  list and a create button, which is exactly what that state needs.

  The empty-daemon copy moved with it. It used to say the write was someone
  else's, and that was true while every create path addressed a
  (workspace, path) pair the page could not name; `POST /api/workspaces`
  retired the premise by minting the id itself.
- **An address the page cannot resolve yet leaves NOTHING selected.** The
  daemon page re-reads its list once when the address names a workspace the
  list does not hold, because the switcher may have just created it. That
  re-read can fail — and keeping the previous workspace selected through the
  failure puts the page on one workspace under an address naming another,
  which is the mismatch the stale-address fallback already refuses to leave
  behind. The error state offers `Create a canvas` only while something is
  selected, so the stale selection is not cosmetic: a create there posts the
  document to the workspace the URL does not name.
- **A rename changes identity and nothing else.** The switcher's rename
  answers with the three identity layers, and the row it lands on also carries
  what the keeper counted — so the answer is MERGED into the row, never
  substituted for it. Replacing dropped the count until something else
  happened to reload the list.
- **The version timeline shows every lane, and offers restore on one.** It
  used to filter its rows to the branch HEAD is on, which made `mini-graph.ts`'s
  own documented rule — "rows on other branches use a ring dot" — unreachable
  from production: every row it drew was active by construction, and the
  renderer did not even branch on it. The only way to see another variation's
  history was to switch onto it first.

  Now the lane carries the answer: solid on the lane you are on, a ring on the
  others, each keeping its own `BranchMeta.color` on the stroke so a ring still
  reads as its lane.

  **Restore stays on HEAD's lane.** Showing another variation's history is not
  the same as offering to restore from it, and what restoring one variation's
  version INTO another means is undecided — an affordance acting on an
  undecided semantic is worse than none. So a row on another lane is a plain
  container, not a disabled button: disabled announces "unavailable", which is
  the wrong story about a row that is doing its job.

  The empty state moved with the filter. It is the document's history now, not
  one lane's, so an empty list means there is nothing anywhere.

  **A row on another lane says which lane, and a row on yours does not.** The
  ring answers "not the one you are on" and stops there; colour is not a name,
  so with two variations open a reader has a row of history and no way to tell
  whose. The lane you ARE on is the frame the whole panel is read in — naming
  it on every row states the obvious and makes the exceptions harder to find,
  which is the same reason the shell names the current workspace once rather
  than on each document.
- **Each switcher row says how much is in that workspace.** A list of names
  gives no reason to pick one; the count is what makes it readable. It reads
  as part of the row rather than as a column, so a keeper that does not count
  leaves no hole where a number would be.

  **Absent is not zero, and the difference is the whole rule.** Zero says the
  workspace is empty — the row a person most needs to recognise — while absent
  says nobody has counted this row YET. So the render is guarded on
  `undefined`, never on falsiness, which would hide exactly the empty ones.

  **Both keepers count, at different moments, and the moment is the design.**
  The daemon counts in `list()`, since one HTTP round trip already carries the
  number. The browser cannot: its documents live in the workspace tree, and
  reading that means loro-crdt's WASM — 3039.5 KB — behind a control that
  renders on every page. So the browser publishes a separate `counts()`, which
  the switcher calls when the popover OPENS. `list()` stays loro-free and
  keeps naming the current workspace on the shell's render path; nothing about
  startup changes, which is what the CI LCP floor exists to hold.

  Measured on the LCP rig's profile (CPU x4, 10Mbps/40ms): **1850 ms over the
  network, 65 ms out of Cache Storage.** Cache Storage is the ordinary case —
  the service worker already precaches that WASM so the editor works offline,
  and `check-pwa-precache.mjs` asserts it — so opening the switcher rides a
  cost the product already pays instead of creating one. Only a first visit
  that opens the switcher before the precache finishes waits, and it waits
  without a spinner: the rows render immediately from `list()` and the numbers
  arrive after, which is precisely what optional-and-absent buys.

  The earlier decision recorded here — that the browser simply would not
  count — was made from the byte budget alone (10.8 KB of headroom against a
  1002.5 KB gzipped dependency) without measuring either the precache or the
  compile, which is 21 ms. The budget number was right and the conclusion
  drawn from it was not.

  The count includes SHADOWED documents. A concurrent create can leave two
  documents on one path and the listing shows both, one marked, precisely so
  the convergent state is visible; a count that quietly omitted the marked one
  would put back the disagreement the mark exists to prevent.

  Measured before it was added, because the cost is invisible in the diff: the
  tree index answers a document listing by OPENING each workspace's record, so
  this turns one registry read into N. Against a live daemon holding 11
  workspaces and 38 documents, the whole call is 4.2ms end-to-end over HTTP —
  on a control a person opens by clicking.

  The daemon counts the rows ONE AT A TIME, and that is not an oversight. The
  obvious `Promise.all` opens N workspace records at once against the one
  SQLite file, and on that same daemon it failed the entire listing with
  `SQLITE_BUSY` — every row lost to contention the count itself introduced.
  A/B against the running daemon: concurrent 500, sequential 200. No unit test
  reaches it, because each gets a fresh database with nothing else touching it;
  this is the class of defect only a real keeper with real data shows.
- **The document browser heads itself with the workspace name.** The other
  half of the answer above, and the only place a sighted reader sees the name
  at all — the shell states it in the mark's accessible name and draws it only
  inside the popover. Both index pages carry it as a visible `h1`, and the
  generic word did not disappear when it left that heading: it moved to the
  panel's own region label (`role="region" aria-label="Documents"`), which is
  where it was always true.

  What it reads is `workspaceLabel` — display name, else segment, else id —
  never a per-site re-derivation, because a site that re-derives ends up
  knowing about fewer layers than there are. Before the row lands the heading
  falls back to the handle the address carries, and past that to the generic
  word: a document browser with no `h1` at all is a worse outcome than a
  generic one.

  **`createWorkspace` on a workspace that exists leaves it alone.** Not merely
  "is not an error" — not an overwrite either. A blind `put` of the input let
  the bare `{ workspaceId }` call an "ensure it exists" caller makes clear the
  identity layers a rename had written. `IdbDocumentIndex` and the in-memory
  double both did this; the daemon never did, because its identity lives in a
  registry its `createWorkspace` does not touch.

  **This was latent, not live, and the distinction is on the record because it
  was first reported the other way round.** Reading the code found a real
  contract violation, and a conformance mutation check confirmed the contract
  was broken — neither says anything about REACHABILITY, and the consequence
  narrated from them ("visiting the document list undoes a rename") turned out
  to be false. An A/B of the built bundle before and after refuted it: the
  segment survived on both. `FoldingBrowserIndex` routes `createWorkspace` to
  the tree index and keeps the IndexedDB one only for `listWorkspaces`,
  `renameWorkspace`, `listDocuments` and `deleteDocument`, so no caller reaches
  the overwrite at all. It is still worth fixing — the row it would clobber is
  the one `renameWorkspace` writes on that same store — but as debt, not as a
  defect anyone hit.

  Pinned for every implementation by the port's conformance suite, whose
  earlier idempotency case re-created with the SAME layers and so could not
  tell an overwriting implementation from a leaving-alone one.
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
  without an explicit reason. **Stateful colour is the one paint-property
  exception**: where the colour IS the state (`StateDot`'s tone, a hover
  affordance), it crosses with `transition-colors` on the normal token
  rather than cutting. There is no transform/opacity encoding of "which
  colour" that also works — stacking tones and fading between them breaks
  the ring shape, whose transparent gap would reveal the layer beneath
  instead of the background. Scoped to chrome-sized elements, where paint
  is free; a full-surface colour transition is still a repaint per frame
  and still belongs to the rule above. `prefers-reduced-motion` is enforced
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
