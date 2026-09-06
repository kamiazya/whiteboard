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
| `--annotation` | the annotation layer, everywhere it is drawn |

`--annotation` is amber, and it is one token rather than two because a
conversation has to read as the same thing on both surfaces: the canvas draws
it as a pin and a bubble, a markdown body as an underline under the quoted
passage plus a dot in the gutter. It is deliberately none of the three above
it — an annotation is not a selection, not a ruler, and not destruction — and
deliberately not `--destructive`, which this product reserves for actions that
cannot be undone.

State colour outside the shadcn set is ONE colour, `amber-500`, and it is
drawn in one place, `components/shell/ShellMark.tsx`. It means "a condition
that asks something of you" and nothing else. There is no colour for "safe":
a document whose writes land and whose session is up draws NO state at all,
because the routine state asks nothing and a mark lit for it would be lit
always — which is what made the header restless while someone typed, and
what the closed set below used to spend `emerald-500` on. What separates two
conditions that share the one colour is SHAPE and MOTION: a filled cap is
"not yet" (a write that is stuck, a session that is reconnecting — the latter
also travels), a hollow cap on a broken stroke is "not keeping" (a refused
write), a filled cap on a broken stroke is the daemon's "not keeping"
(sync-off). The word for each lives in the accessible name and the popover.

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

    Two gestures, both finite, one per direction. A keeper giving up
    (`sync-off`, a refused browser write) arrives with an attention echo.
    `reconnecting`/`sync-off` → `synced` plays a recovery draw — the RARE
    moment, not the routine one. There is deliberately no "a write landed"
    celebration: the daemon keeper has no write-landed signal to hang one on
    (its `session` is derived from transport liveness, not from an ack), so
    shipping it would light up for browser-kept workspaces only and read as
    "the daemon is not saving" — which is exactly what "never offer what the
    keeper cannot honour" below forbids.

    The mark answers for BOTH keepers now, each with the health it can
    vouch for: the daemon's is its session; the browser's is its storage
    (`StorageHealth` — whether the writes behind the open document are
    landing, judged from the facts the sync session, the markdown save and
    the controller report). A browser-kept document used to carry a second
    carrier, a save-state chip beside its title, that went amber on every
    keystroke and emerald half a second later. It was removed (2026-09-05)
    rather than quietened: the unsaved few hundred milliseconds while
    someone types are the ordinary state, ask nothing, and are not shown.
    What is shown is a CONDITION — an edit unsaved past `STUCK_AFTER_MS`, or
    a write the store refused — and "is it saved" is answered on asking, in
    the mark's popover, with the time the last write landed.
  - **version dot** — retired. `HeaderVersionDot` ("are there edits no named
    version holds yet?") was removed with the version history rework
    (#1245); the History panel is where a named version is taken and seen.
  - **AppShell gear's attention dot** — brand blue, actionable-todo only.

  Anything else stateful in chrome needs this list amended first, takes
  amber or nothing, and puts its word in the accessible name.
- **The AppShell owns brand, connection, fullscreen and settings.** Every
  page mounts `AppShell` (the signature mark, the ALPHA honesty chip, the
  fullscreen toggle, the settings gear + attention dot) and never renders its
  own brand, connection, fullscreen or settings chrome. Fullscreen is the
  shell's because its subject is the app — how much of the screen it gets —
  which does not change when a document opens; the target is the whole
  document (`hooks/use-fullscreen.ts`), both chrome rows step aside in it,
  and the shell floats the one way back out.

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
- **Every control in the two chrome rows serves one of four roles, and its
  ROLE follows from its subject.** The roles are:

  | role | asks | where it lives |
  |---|---|---|
  | **identity** | where am I? | the mark (workspace), the document's title, the way back |
  | **inspect** | what am I looking at, beside the document? | ONE slot, exclusive: properties, comments, connections, history |
  | **act** | what do I do to this document? | ONE `⋯`, in ADR-0006's band order |
  | **view** | how much of the screen, and how is it drawn? | fullscreen in the SHELL row (subject: the app), `Display…` inside the `⋯` (subject: this canvas) |

  Two things follow, and both were violations before this rule existed:

  - **Inspect is one slot, not N toggles.** Properties, comments,
    connections and history each owned their own open state, and nothing
    said they were alternatives. Captured on a phone before the retune: the
    display popover, the comments rail and the history sheet all up at
    once, over an editor with room for one. `lib/inspector.ts` declares the
    union and `InspectorPanel` is the single vessel — a fifth panel joins
    them rather than opening beside them.
  - **A view control's ROW follows its subject, not its convenience.**
    Fullscreen asks how much screen the app gets, which does not change
    when a document opens, so it is the shell's. Display settings ask how
    THIS canvas is drawn, so they are the document's — and being one
    plugin's worth of edge routing, they earn a menu row rather than an
    icon in a row the title wants.

  What this rule refuses is the control with no answer: an affordance added
  to whichever row its implementing file already rendered. That is how the
  rows came to hold five button spellings, a second `⋯` a header above the
  first, and a fullscreen toggle whose subject was a `<main>` element.
  `header-button-surface.test.ts` is the mechanical half — one class set,
  and the count per file pinned by equality from both sides, so a new
  control cannot arrive without changing a number there. Which role it
  serves stays a reader's judgement: the controls are written per-file and
  are not declared anywhere one scan could enumerate, and until they are (a
  registry every header control registers with is the upgrade path) a
  per-item table here would be the hand-kept list this file exists to
  replace.
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
  `.claude/rules/vocabulary.md`'s keeper section. The whole-workspace MOVE
  to a daemon is implemented (Settings > Connections, "This workspace"),
  and a VERIFIED move now completes ADR-0023's demote: the old browser copy
  is deleted and replaced by a cached replica of the daemon workspace, so
  copy may say "kept by the daemon, cached here". Continuing from the
  daemon is still a narrated reload the user takes.
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
  exception**: where the colour IS the state (the shell mark's cap, a hover
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

**A card opened on the canvas is an object-action surface too.** The
proposal card's Adopt and Dismiss (ADR-0029 decision 4) render icon-only
under this rule, with `aria-label` and a `title` tooltip carrying the name.
The glyphs are CIRCLED — `CircleCheck` / `CircleX` — while the card's own
Close stays a bare `×`: a ring means a verb that writes something, a bare
mark means chrome, which is the distinction the comment card's
`CircleCheck` Resolve beside its bare `×` Close already teaches. They sit
in their own row at a coarse pointer's 44px rather than beside Close,
because Dismiss is the one verb on that surface no Undo reaches.

The same row carries the per-change disclosure, and what it discloses is
one more pair of those same glyphs per change. Two things keep that from
reading as four identical buttons: the default pair is named by its COUNT
once there is more than one change (`Adopt 2 changes`), and each row's pair
names what it decides (`Adopt: Move “the plan”`) — the names do the
distinguishing that the icons deliberately do not.

Both vessels — the right-click list menu and the ⋯ grid — draw the SAME
catalog in the SAME band order: property rows (color, z-order, arrows;
the menu stays open), then verbs (one-shot; the menu closes), then the
destructive entry alone at the bottom. What is learned in one vessel
must transfer to the other, so a new action is added to the catalog,
never to a single vessel.

## Comment surfaces: two hosts, one set of parts

A conversation is read and answered in three places — the card the canvas
opens on a bubble, the markdown editor's in-place projection
(`markdown-editor/annotation-decorations.ts`: a mark over the passage and a
gutter marker beside its line), and the document-level rail both editors
share (ADR-0026 decision 5; `useCommentsRail` holds its state,
`CommentsRailAside` is its vessel — a column where there is width, a bottom
sheet over the editor under 768px, since a 288px column beside a 412px phone
screen left the editor a strip a finger could not write in). The rail is one
of four panels sharing the page's ONE inspector slot (`lib/inspector.ts`,
vessel `InspectorPanel`): a markdown document's properties, its comments, the
documents linking to it (a daemon keeper only), its history. Opening any one
closes the others and every opener reads released, because two panels beside
one editor — measured on a phone as the display popover, the comments sheet
and the history sheet all open at once — is what the header retune set out to
end; the properties editor and the connections list used to overlay UNDER the
header instead, a third shape for the same job. The rail carries
the conversation's own verbs beside its reply box — Resolve/Reopen and Edit
of the opening message — because a NOTE's thread has no card, and the rail
is the only place it can be closed or corrected; both go through the threads
plane (`set-thread-status`, `edit-thread-message`), which the flat comment
path could never reach for a passage or a document-level thread. The preview
(Read/Split) marks each conversation beside the block its passage starts in,
so a reader who never opens the source can still find one. The card composes
shared parts:
`annotations/message-meta.tsx` (who and when), `ReplyComposer` (the box,
Cmd/Ctrl+Enter, the empty guard, the draft that belongs to one thread) and
`ThreadReplies` (the replies under the subject line).

Three things every such surface needs are INTRINSIC to the canvas root, so a
new one gets them without being wired — each was forgotten once, on the
comment card, and shipped that way to a phone:

- **Overlay recognition.** The root's pointer guard and its native
  `touchstart` refuser ask one predicate, `isEditorOverlayTarget`, and it
  recognises native controls, links and dialogs by what they are.
  `data-editor-overlay` remains the opt-in for chrome that is not a control.
  A control the root does not recognise works under a mouse and is dead to a
  finger — a cancelled `touchstart` is also a cancelled click — which is how
  the card's Close shipped unreachable on the one device with no Escape.
- **Keyboard avoidance.** `useKeyboardAvoidance` follows FOCUS: whatever
  text entry inside the root has it, the overlay that owns it is kept above
  the keyboard and inside the root, by panning. Nothing is wired per editor.
  The root is `overflow: clip`, never `hidden`: a hidden-overflow box is a
  scroll container the browser scrolls to reveal a focused control, and it
  did — 38px under a viewport state that knew nothing about it.
- **Timestamps.** One formatter, `workspace-files/format-relative.ts`:
  "5m ago" while fresh, the reader's local M/D HH:MM once age stops being the
  fact. `time-format-discipline.test.ts` reads every source file for a
  hand-rolled stamp, because the formatter's own comment said "one
  formatter" and was forked anyway, into a UTC slice chosen for a
  deterministic test. Determinism is the test's job (pin the clock).

A fourth thing is not intrinsic and is guarded instead: PARITY. What a reader
can do with a conversation is the same set of verbs whichever surface shows
it — open, reply, resolve, correct the subject — or the surface says why not.
`apps/web/annotation-surface-parity.test.ts` is the matrix (capability ×
surface), every cell either naming the test that pins it or the reason it is
absent; the rule is `.claude/rules/coverage-ledger.md`'s last section. It
exists because the rail shipped without Resolve beside a card that had it,
and a note's thread has no card — nothing was red.

The card itself is a non-modal dialog: it slides inside the root's edge like
the context menu, a press on the canvas dismisses it like a menu, and Escape
does too. A press on comment chrome opens it under EITHER tool — the hand
tool takes every plain press as a pan, but a comment is chrome, not content,
and the release decides: a press that never travelled past the slop opens
the card, one that travelled was the pan (hand) or the pin drag (select) it
became on its first move. The same line runs through the hand tool's MENU:
a right-click, or a stationary touch long-press, opens the context menu
there too, carrying the annotation layer's verb for what is under the press
and nothing else — "Comment here" on a spot, "Comment on this" on a node or
an edge, a comment's own lifecycle on its bubble — and the press selects
nothing on the way (`context-menu-items/annotation-verbs.tsx` is the one
definition those rows and the Select menus share). The hand tool used to
open no menu at all, because an EDIT affordance surfacing mid-pan was the
harm on a phone; a comment verb is not one, and a reader panning around a
canvas has as much reason to talk about it as one selecting on it. The
long-press timer is armed under the hand tool for the same reason, and it
strands no pan: a finger that travels clears it before it fires, and one
that does not has not panned. The press arms nothing visible until then, on
purpose: arming the pin drag at the press took the committed copy out of the
surface under a touch pointer implicitly captured on it, and its release
then died on a detached node — every later tap replayed the stale press.

**Where a conversation can be opened, and how.** Every place a reader can
point at has one entry, and the entry belongs to the surface the place is
on — a menu row where the place is an object, a catalog row where it is
text:

| place | entry | anchor |
|---|---|---|
| a spot on the canvas | canvas menu, "Comment here" | `spatial` point |
| a node | node menu, "Comment on this" | `spatial` + `nodeId` |
| an edge | edge menu, "Comment on this" | `spatial` + `edgeId` |
| a passage of a text node | the editing catalog's "Comment on this" (right-click inside the node's editor, with a selection) | `text` + `nodeId` |
| a passage of a note | the editing catalog's "Comment on this" (⋯ and right-click, with a selection) | `text` |
| several nodes at once | node menu on a multi-selection, "Comment on selection" | `spatial` + `nodeIds` + the box they occupy |
| a region of empty canvas | no entry yet in the editor — an agent names the rect through `wb_thread_edit` | `spatial` + `width`/`height` |
| the document as a whole | the comments rail, "Comment on the document" — a note and a canvas alike | `document` |

A node set is drawn as a dashed outline around the box its LIVE members
occupy (`spatialAnchorRect`, model: the stored rect is only where an
orphaned set is drawn from), with the pin at the box's top-right corner;
the rail labels it "N nodes". A document-level thread is drawn nowhere —
the container is on no surface — so the rail is both where it starts and
where it is read, labelled "whole document".

Comment is deliberately OUTSIDE `MARKDOWN_EDITOR_VERBS`: it writes nothing
into the body, it opens a conversation beside it, and the table's keymap and
verb bar cannot resolve a scope for it. The editing catalog is ONE builder
(`verb-catalog.tsx`) for the note editor's ⋯ and right-click and for a
right-click inside a node's editor, so the two editors cannot offer
different verbs for the same text; the Comment row rides in as the host's
seam, present only with a selection. The canvas answers it with its compose
bubble at the node's corner; a note answers with the rail's compose box,
quoting the passage. Both write the same thread shape. The menu takes focus
for its rows, and the node editor — which commits on blur — reads a
departure INTO a menu as the catalog's, not the user's; the menu hands the
caret back on close (`ActiveMarkdownEditor.focus`), so the edit outlives the
menu and still commits on the next real exit.

A passage is drawn where its words are, on every surface that has them:
the note's source pane and the node's editor as CodeMirror decorations (the
node's editor takes the marks without the gutter, `annotationMarks`, since
a gutter in the node's own box would shift the words away from where the
committed render draws them), the static canvas as highlight shapes
canvas-render composes behind the runs (from the `threads` it is handed;
the pin still comes from the flat projection the optimistic state holds),
the export through the same layout, and the MCP Apps widget from the
`threads` `canvas_view` hands it.

The source pane's gutter reserves its width whether or not the document has
any conversations, so a thread arriving from a peer cannot reflow the body
sideways under whoever is typing in it — and it PAINTS nothing, so that
reserve reads as the body's own margin until a marker appears in it. The
rule lives in the editor's own `EditorView.theme` and not in `index.css`,
which is the whole reason it was missing: CodeMirror injects its base theme
unlayered, and this app's stylesheet is inside a Tailwind `@layer`, which
loses to unlayered rules whatever its specificity. Unoverridden, that base
theme's light grey fill and light right border painted a near-white band
down the left of every note on the dark theme, on a document with no
comments at all.

**Opening one takes a caret, not a selection.** The scope is the reader's
selection when there is one and otherwise the BLOCK their caret is in
(`lib/block-range-at`), which is a different claim from the one every
formatting verb makes about the word under a caret: a word is a guess at
what someone meant, and a paragraph is a unit they have already pointed at.
Requiring the selection is what made the layer unreachable on the surface
that needs it most — selecting a passage on a phone is a drag between two
handles, and a phone has no right-click. On a blank line the nearest block
is taken rather than none, because a control's enabled state has to derive
from something that re-renders it and a caret does not; the one remaining
null, a body with no prose, is derivable from the value and is the only
case the entry is inert for.

The same press READS as well as writes: a paragraph a conversation is
already about opens that conversation instead of starting a second one.
That is what makes the layer reachable on a phone at all. The gutter marker
was measured at 12x12 px starting 3px from the screen edge — half of WCAG
2.5.8's 24x24 minimum in each dimension, a quarter of its area, and inside
the strip a phone
OS keeps for its own back gesture — so it cannot be the only way in. Its
own press area is 26x24 now (the button is the target and the 12px dot
inside it is the picture, since a bigger dot beside prose reads as content;
a `::after` overhanging the old 18px gutter was tried first and reaches
nothing, because `.cm-gutterElement` clips it and the toolbar above and the
content beside win the hit test where it does extend). But a caret in the
paragraph plus a toolbar button is the path with a target the size of the
paragraph, and that is the one a thumb takes.

**Four places measure their origin from the preview document's SVG, and
they ask for it through one definition.** `previewDocumentSvg` exists
because a bare `querySelector('svg')` inside the preview column answers with
a comment MARKER's icon the moment a document has a conversation on it — the
markers live in that column, each carries one, and they render before the
pane. The marker placement was therefore reading its own previous output as
its origin.

Measured before it was named: markers stood a constant **+62px** below the
blocks they quote — identical for the first block and the last, which is
what ruled out a scale error and a stale-anchors error and left a pure
translation. The query returned `viewBox="0 0 24 24"`, and the `svgTop` it
produced was **165** where the document's is **32**. The residual after the
fix is 5px, which is a `<text>`'s box starting at the cap height.

The other three call sites had the same defect and nobody had reported it:
the scroll sync, the seek, and the minimap rail's viewport box were all
wrong on any document with a comment. Scoped by the pane's own class rather
than by DOM order, so the next element added to this column cannot bring it
back, and a source scan in `preview-marker-placement.browser.test.ts`
refuses a bare query returning.

**Resolving a conversation MOVES it, rather than making it disappear.** The
row crosses to the resolved look, holds 200ms so the change can be read,
then fades and slides out while the rows below glide into the gap by
transform (FLIP in `CommentsPanel`, so the list never animates its own
height). Durations are the motion tokens; the hold is the one number that
is not a token yet, because there is none for "long enough to read a state
change".

**The subject of the transition is the ROW, and that was measured rather
than chosen.** The first version crossed the marker and let everything else
cut; frames from a real browser at 130ms showed the row already fully muted
with its verb already reading "Reopen" while a 12px dot in the corner was
still animating. Every duration ran correctly and the result was
indistinguishable from no animation at all. A word swapping is a hard cut
no easing can soften, so the verb's LABEL waits for the crossing to finish
and never swaps at all on a row that is leaving.

Two things the beat must not do, both of which it would do naively:

- **It must not delay the WRITE.** `onResolve` fires on the press, so a peer
  sees the change at once and a reader who navigates away mid-beat loses
  nothing. Only the presentation waits.
- **It must not show the OLD state while it waits.** The status arrives from
  the host a render later, so the panel holds the status it just asked for
  (`pending`) and the row wears that. Measured: with a host that had not
  answered yet, the held row still read `open` — a beat spent showing
  nothing, which is the cut with a pause in front of it.

Not collapsed under `prefers-reduced-motion`, deliberately: the global floor
in `index.css` already flattens the movement, and a reader who asked for
less motion still has to see what their press did.

**The canvas PIN ramps too, and getting there took three corrections.** The
first answer — that it could live in the web app without touching the
renderer — was wrong. The second, that `canvas-render` emits no handle for a
scene node, was also wrong: that was true of the plain serializer, and both
the editor and the preview mount the KEYED projection, whose groups are
`<g data-wb-key="…">` keyed by the scene node's own id.

The third correction is the one that changed the design. This paragraph used
to say the blocker was `keyed-svg-patcher` REPLACING a group whose bytes
change, and that a resolve is an appearance change. It is not, under the
default `showResolved`: measured on a real layout, resolving a conversation
reports its pin, count, leader and whole bubble as **GONE**, not changed —
`layoutSpatialCanvas` stops composing them. Only with the toggle ON is it a
recolour. Both were cuts, and the fix had to cover both.

So the patcher ramps opacity for the groups `canvas-render` marks as the
annotation layer, on arrival, on departure and on a replace in place.
Three things that scoping and that scoping alone buy:

- **The mark comes from the producer, never from the key's shape.** A stored
  comment id may contain a `/` exactly like a document node id can — the
  same trap `ShapeSceneNode.commentChrome` exists to avoid in `sceneDigest`.
  `sceneEntries` answers it in the walk that already assigns keys, so
  ownership carries it to the count on a pin and the body in a bubble,
  neither of which has an id to be marked by.
- **Everything else keeps cutting.** A document group replaced in place is a
  keystroke inside a node; ramping those would ghost while somebody types.
- **A LAYER swap is not an edit.** The editor patches one container from two
  producers, and both swaps reach the patcher as a removal. The drag
  backdrop is the obvious one; the second is not — a dragged comment is
  taken out of the COMMITTED render by `keyedWithoutPrefix`, so grabbing a
  pin left a fading copy at the anchor the pointer had just left, under the
  preview carrying it. `update(next, { animate: false })` says which, and
  `comment-move.browser.test.tsx` is what caught the miss.

Two things measurement corrected after the mechanism worked:

- **The easing.** `--motion-ease-out` is shaped for a MOVE — nearly all its
  travel is in the first fifth so an object settles gently — and on opacity
  that hides the event: captured in a real browser, the pin was 65% faded
  40ms in and invisible by 110ms, so a declared 220ms ramp spent its second
  half on a hundredth of a percent. Leaving accelerates and arriving
  decelerates instead; the scrub now reads 1.00 / 0.88 / 0.57 / 0.14 at
  0 / 60 / 130 / 200ms. Photographing motion needs the animation PAUSED and
  scrubbed — `page.screenshot` is asynchronous, and a frame taken by
  sleeping 40ms was really taken after the ramp had finished, which produced
  a figure showing an empty canvas while `getComputedStyle` read 0.96.
- **The clip.** The editor's SVG document IS `sceneBounds`, so resolving the
  OUTERMOST conversation re-fits the element around what is left — measured,
  `40 60 490 170` became `40 150 200 80` — and the departing chrome landed
  outside it under the UA's default `overflow: hidden`. That clipped the
  ramp exactly where a comment usually sits, while every unit test stayed
  green: they assert the animation EXISTS, not that anything is painted.
  `.canvas-surface > svg { overflow: visible }` is sound rather than a
  patch — the viewBox is the union of everything in the scene, so a ghost is
  the only thing that can ever be outside it.

**The markdown markers cross rather than leave, and that is the opposite of
the canvas for a measured reason.** This editor is handed EVERY thread,
resolved ones included, so nothing goes: the gutter dot, the passage
underline and the preview marker all stay and change. A leave animation
would be wrong here for the same reason a cross would be wrong there.

Three markers, and DOM identity did not agree across them — measured over
one resolve, not assumed:

- **The CodeMirror gutter dot was REPLACED** (`same-element=false`), so
  nothing could transition on it. Its `.cm-gutterElement` wrapper was the
  same element throughout, and that is where the state moved. It cannot ride
  the dot's own marker: CodeMirror re-reads `elementClass` only when a
  line's marker set differs, and decides that with the same `eq` that
  governs whether the dot's DOM is reused — so one marker cannot both keep
  its element and announce a new class. An `elementClass` getter on it never
  reached the wrapper at all. `gutterLineClass` is the facet provided for
  exactly this, and `ResolvedLineMarker` satisfies its contract: a class, no
  `toDOM`.
- **The passage highlight is replaced too**, and is left cutting. Its state
  is carried by a `Decoration.mark` class, which has no wrapper to move to;
  the same trick would need a second decoration layer for a span that is
  already legible from the dot beside it.
- **The preview marker was reused** by React key and said nothing about
  resolved at all — a closed conversation's marker was drawn exactly like an
  open one, which is a gap rather than a motion problem. With `data-status`
  present the crossing needs nothing but a class.

**The rail's verbs are icon-first, and the status dot IS the Resolve
toggle.** "Object-action surfaces are icon-first" below was written, the
canvas card followed it (`CardAction`), and the rail never got held to it:
the SAME four verbs drew icon-only there and icon + label here. Nothing was
red, because the parity matrix checks which capabilities a surface has and
not how it draws them.

Two halves ship together and the second is the load-bearing one. Measured,
today's verb was `71×22` — under WCAG 2.5.8's 24 in the dimension a thumb
needs — so dropping the labels while keeping `px-1.5 py-0.5` would have
taken the width the label was giving the target and given nothing back.
`ICON_VERB_CLASS` is 44px, and a test asserts the computed box rather than
the class. The labels also cost the subject a line: the same excerpt wraps
to three beside them and two without.

The dot merging with the verb is the further step, and it pays twice: the
rail row had NO status indicator at all before, and the state and the verb
being one object is what puts the resolve transition under the finger that
caused it. It cost a restructure — the row was a `<button aria-expanded>`
and a button inside a button is invalid, so the row is now an `<li>`
holding the dot-toggle and the subject toggle as siblings. The subject
toggle stays the row's heading, so the focus contract above is unchanged.

Three carve-outs, each with a reason the rule itself gives:

- **Submit is inert before it is pressed, not just guarded after.** The
  rule's rationale is that a misfire is one Undo away; Resolve, Reopen and
  Edit each are, and **a sent comment is not**. The submit stays guarded in
  the handler (so the Meta+Enter path takes the same rule) and adds
  `aria-disabled` while the draft is empty — with no label to read, a press
  that does nothing has to say why beforehand. The driver refuses to click
  an `aria-disabled` control, which is the state reading correctly and also
  why the tests exercise the guard through a raw `.click()`.
- **A submit is named for what it sends, not for the field.** `Reply` on
  both the box and its button made `getByLabelText('Reply')` ambiguous and
  broke ten tests at once — a collision a reader hits too. `Send reply` /
  `Send comment`.
- **Cancel is not an object verb and is gone.** An X there is the third
  meaning of that glyph in one panel. Escape carries it: an edit first,
  then a compose draft — and cancelling a compose returns focus too, since
  the draft box is what focus was moved to.

**A marker says how much is in the conversation it stands for.** Before
this, every in-place marker said only "somebody is talking about this", so
deciding whether to open one meant opening it. The gutter dot and the
preview marker now carry the conversation's message count past one — past
one, because a digit beside every lone remark is noise and the count only
says something once there is more than one — and the rail's row carries the
count with the stamp of when the conversation LAST moved
(`lib/thread-activity.ts`).

That stamp is deliberately not the one already beside the subject. The row
carries the opening message, so its stamp answers "who started this, and
when"; for a conversation running over days the question a scanning reader
is actually asking is "has anything happened", and those have different
answers. An edit counts as movement — a rewritten subject is news to whoever
already read it, and `editedAt` is the only record that it happened. The
comparison is by INSTANT, not by text: `okfTimestampSchema` accepts `Z` and
an explicit `±HH:MM` alike, and midnight in Tokyo is the earlier instant
while being the later string, so a lexical max reports a conversation as
fresher than it is. (The model's `compareMessages` does compare as text,
deliberately — what it needs is one order two peers agree on, and agreement
is not chronology.)

The gutter dot holds ONE digit and it now belongs to the conversation
rather than to the line. The line's own count — more than one conversation
on it — is the rarer fact and keeps its own channel, `data-threads`, drawn
as a second ring behind the dot and said in words in the label, so the
second conversation is still never silently dropped.

The canvas PIN carries it too, composed into the SCENE by `canvas-render`
rather than drawn by this app, so the widget, the export and
`wb_scene_render` get it for the same reason they get the pin. The count
comes from `threads` — the flat `comments` projection carries one text and
cannot know — which makes a count on the canvas a claim about the WIRING as
much as about the renderer, and `comment-pin-count.browser.test.tsx` is what
holds the editor to handing the layout its threads. The digits take the
bubble's fill from the theme, because layout assigns paint and never invents
it; a resolver that predates the slot lays the count out unpainted, the way
`passage` and `region` already work.

`message-count` is a row in the annotation parity matrix now. The canvas
being the last surface to carry it is exactly the drift that matrix exists
to make visible, and it had no row to be visible in.

Read status is a separate question and NOT answered here. `commentThreadSchema`
carries no `readAt`/`readBy`, and adding one needs an answer to "whose read"
that this app cannot give — `commentMessageSchema.author` is optional
because a browser-kept workspace has no signed-in author. Last-activity is
what can be said honestly today, and it is what both a per-device read
marker and a shared one would be built beside rather than instead of.

**Opening a conversation moves the reader into it, and Escape brings them
back.** Reading a conversation and writing the body are two modes, and the
press that opens one has to land somewhere: a revealed thread takes focus on
its row — the conversation's heading, and the place Tab continues from into
its verbs, its replies and its reply box — while a new one takes it on the
draft box, which is the whole of what was asked for. Left as it was, the
rail opened beside an editor that still held the caret, so the keyboard kept
typing into the document, the conversation was unreachable without the
pointer, and on a phone the virtual keyboard stayed up over the rail that had
just opened — which reads as the press having done nothing.

Moving focus is only safe with a way back, so the two are one decision.
Escape unwinds a layer at a time: an edit in progress first, then the panel,
and `useCommentsRail.returnFocus` hands focus to whatever held it when the
rail was opened. That is read from `activeElement` inside `revealThread` /
`composeThread` rather than named by each caller, because four surfaces open
this rail — a gutter marker, a preview marker, the toolbar button, a canvas
pin — and every one of them is already holding focus when it calls in; a
parameter would be the same answer written out four times, and the fourth
surface is the one that would forget. `selectThread` deliberately does NOT
capture: picking another conversation from inside the rail is not an entry,
and re-capturing there would make the way out a row of the list the reader is
standing in.

Two cases need no guard, which was measured rather than assumed after guards
for both proved impossible to fail: `focus()` is a no-op on `document.body`
(what `activeElement` answers when nothing holds focus) and on a node the
surface has since unmounted, so the reader stays put in exactly the cases a
guard would have arranged. What DOES need code is the catalog path — its menu
row unmounts on close, so `useAnnotationEntry.open` puts the caret back in
the body before telling the host. Two things depend on that and neither is
visible from the press: the caret IS the scope, and the way back out is
whatever held focus at that moment.

**Where that entry lives on a phone is the toolbar the docked bar makes
redundant.** With the caret in the body a phone shows two bars, and five of
their verbs were the same five — Heading, Bold, Italic, Bullet list, Task.
So while `touchFormattingBarShown()` is true, the toolbar under the header
swaps its formatting cluster for what the docked bar does not carry: the
annotation entry. The verbs return the moment that bar goes (a desktop, or
a caret outside the editor), so the swap costs nothing and the duplicate
row is spent on the one affordance that had no button anywhere.

## A toggle looks toggled, and says so once

A control that switches something on — a rail, a popover, a tool, a filter —
expresses that state **from its ARIA attribute**, through
`TOGGLE_STATE_CLASS` (`components/ui/dock-button`) or an
`aria-pressed:` / `aria-expanded:` variant of its own. `aria-pressed={open}`
is then the ONE place the state is written.

Two spellings this replaced, both of which had spread across the app:

- **doubled** — `aria-pressed={open}` beside `open && 'bg-accent …'`. The
  same fact in two places, so an editor who changes one leaves the picture
  disagreeing with what a screen reader is told.
- **absent** — the attribute alone. Announced, invisible. Found in the
  running app on the comments rail: its opener looked identical open and
  closed, and on two other controls nobody had noticed.

`toggle-state-surface.test.ts` holds it: it reads the opening tag of every
element with a dynamic `aria-pressed`/`aria-expanded` and requires the state
to be derived there. Class constants that compose `TOGGLE_STATE_CLASS` are
found by scanning rather than listed, so `TOOL_BUTTON_CLASS` counts without
anyone maintaining a name list.

**A control may keep its own look.** The segmented control in the markdown
toolbar raises its selected segment instead of filling it
(`aria-pressed:bg-background aria-pressed:shadow-sm`), and the edge-routing
options add `aria-pressed:font-medium`. What the rule fixes is where the
state is written, not what it looks like.

Exemptions are listed in the guard with a reason each: a tree row's
disclosure triangle expresses itself by ROTATING, and the canvas context
menu's `aria-expanded` is about its colour submenu while its `bg-accent` is
about the selected colour — two different subjects, so deriving one from the
other would be wrong.

And use the **theme tokens**, not raw palette steps. The comments filter
shipped with `bg-neutral-200 dark:bg-neutral-700` — a second colour system
beside the one every other control uses, which does not follow a theme
change.

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
