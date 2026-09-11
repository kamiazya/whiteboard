# ADR-0013: The facet system — plugins, versioned facet keys, and the meaning/display split

**Status:** Accepted

## Context

ADR-0009 decision 3 confined facets to OKF frontmatter ("`Facet` belongs to
OKF") and paid an explicit cost: a spatial document lost `type`/`tags`, and
metadata on a diagram was deferred to an unbuilt workspace-level capability.
Its Consequences named the question this ADR answers: *what OKF frontmatter
this project standardises on* — and, wider, what a facet is at all.

Since then, three things changed the ground:

1. **The `issue/1` retirement taught the failure mode.** An extension facet
   convention was implemented without an agreed schema; because extension
   payloads round-trip unvalidated, whatever someone writes becomes the
   convention by accident. The retirement left a standing rule — "agree the
   schema first" — and this ADR is that agreement's structural form: a place
   where facet schemas are *registered*, so a convention cannot arise by
   accident again.
2. **The product direction asks for more than frontmatter.** The facet idea
   here is borrowed from OpenLineage: freely defined, named, versioned
   attribute groups attached to entities. The concrete wants are metadata on
   canvas *nodes* (shapes, symbols, cloud-provider icons for infrastructure
   diagrams), on the *canvas* itself (themes aligned to official design
   guidelines, hand-drawn style), and eventually ticketing fields on markdown
   documents — with visual rendering, editing UI, and chat-side (MCP Apps)
   access. SaaS and self-host deployments are planned, so extension
   governance and security are first-class constraints, not afterthoughts.
3. **The display substrate already landed.** canvas-render now draws
   non-rect node silhouettes from a shape *kind*, icon scene nodes from a
   vendored lucide subset, and outline-aware edge ends — written so an
   unsupported runtime shape value (a future stored facet payload) degrades
   instead of throwing. What remains is the data half this ADR specifies.

## Decision

### 1. A facet is a namespaced, versioned, schema'd attribute group attached to an object

This supersedes ADR-0009 decision 3 and adopts the alternative it rejected —
"facets as format-agnostic document metadata" — *with the safeguard whose
absence was the reason for rejecting it*: facet schemas are registered at
distribution time (decision 3 below), so the format-agnostic bucket can no
longer breed accidental conventions. OKF core frontmatter (`type`, `tags`)
is unchanged and remains a markdown-document concern; what widens is where
*extension* facets may attach.

The design judgment rule for growing the system: **a new question gets a new
facet; a new answer to an existing question extends that facet's value
space** (e.g. emoji is a new answer to "what symbolises this object", so it
is a union member of `visual.symbol`, not a new facet). Facets stay
independent dimensions (the library-science sense): one facet's value never
constrains another facet's options.

### 2. Facet keys are `{namespace}.{name}/v{n}`

Pattern: `/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/v[0-9]+$/`, e.g.
`visual.shape/v0`, `ticketing.ticket/v0`.

- The **namespace** is the owning plugin's id. There is no unnamespaced key
  and no privileged core namespace: Kubernetes' unprefixed legacy API group
  is acknowledged debt there, and copying it would copy the debt.
- **`v0` is unstable**: breaking payload changes are allowed without a bump.
  Old payloads that no longer parse are dropped on read (the existing
  drop-not-fail storage rule absorbs them). **`v1`+ bumps only on breaking
  change**; additive optional fields land in the same version.
- The previous `{domain}/{version}` numeric grammar (`kanban/1`) is removed
  without compatibility — there are no real stored facets under it, and a
  stored old-grammar key is dropped on read like any other malformed key.

### 3. Plugins are the unit of registration, distribution, and governance

A plugin bundles facet definitions with everything that gives them meaning:

- **Data layer** — `facets`: name, version, `targets`, Zod payload schema,
  and `compat` (decision 7).
- **View layer** — `views`: declarative view specs that name a *kind* from
  the engine's catalog and declare which facets they read (`reads`,
  same-plugin only; cross-plugin reads are coupling smuggled across a
  package boundary).
- **Editor layer** — `editors`: declarative editing specs built from the
  engine's widget catalog.
- **Assets** — symbol sets, themes, fonts; resolvable in both composition
  roots so `wb_scene_render`/PNG export draw what the editor draws.

Registration happens at **distribution time only** (a Vite-config-like
mechanism; SaaS deployments swap plugin configuration per tenant). There is
no runtime user-defined facet — the governance and security blast radius of
runtime extension is wider than it looks, and the ticketing case shows the
escape valve: runtime-variable *vocabulary* (a workspace's status set) is
payload of a workspace-target facet, not a runtime schema. Load-time
collision checking is per plugin id; no central registry (OpenLineage's own
registry is still an unadopted proposal years in).

The bundled plugin (`visual`: `shape`, `symbol`, `theme`, and the
edge-style facet that replaces the ad-hoc `x-whiteboard.edgeRouting`
preference) goes through this same pipeline with **no privileged wiring** —
it is ordinary, disable-able, and sorts lexicographically with everyone
else. "Core" names only the engine: the kind catalog, widget catalog,
contribution points, token contract, targets vocabulary, key grammar,
validation and migration machinery — closed sets the engine owns. No facet
is core.

### 4. Targets are declared by the definition, along two dimensions

The engine allows attachment to any object kind; each facet declares where
it may attach (`targets`) — the same inversion OpenLineage uses. The
vocabulary has two dimensions:

- **Container targets** (format-agnostic): `document`; `workspace` reserved.
- **Content-structure targets** (contributed by a format): the spatial
  format contributes `canvas`, `node` and `edge`. A future format
  contributes its own structure targets. `document` and `canvas` are
  different concepts and must not be conflated — one is the workspace unit,
  the other is the spatial format's surface.

### 5. Storage slots

- `document` → the existing `facets` bucket (one CRDT key per facet, so
  concurrent writes to different facets both survive; within a facet,
  replace-whole-payload, matching OpenLineage's re-emit-replaces rule).
  Projected to the OKF `facets:` block on export.
- `canvas` → the JSON Canvas root `x-whiteboard.facets` object.
- `node` → the node's `x-whiteboard.facets` object (payload only, so the
  node-level content-only rule holds).
- `edge` → the edge's `x-whiteboard.facets` object. Payload only and never
  an embed: unlike a node, an edge carries no content JSON Canvas cannot
  express, so the site is the bucket and nothing else.

The canvas-level `x-whiteboard` rule is amended from "rendering preferences
only" to also carry the `facets` bucket; the existing rendering preferences
are re-modelled as canvas-target facets in a follow-up increment, after
which the bucket is all that remains. A document-target facet on a spatial
document is container-layer information and is not projected into the JSON
Canvas export (it would collide with canvas-target facets there).

### 6. Four validation layers

| boundary | rule |
|---|---|
| schema boundary (keys) | reject, not drop — a malformed key fails the parse |
| write, registered facet | payload validated against the registered Zod schema; invalid writes rejected |
| write, unknown facet | passes through unvalidated (round-trip safety for other tools and future plugins) |
| storage read | drop, not fail — a malformed key or unreadable payload is skipped |

### 7. Per-facet compatibility migrations live in the definition

A definition carries `compat`: for each older version, the retained old
schema and a pure migration function to the next version; the registry
composes the chain (`v0→v1→v2` — the linear-history form of hub-and-spoke,
no N² converters). Reads are lazy (parse old → migrate → parse current;
any failure drops per layer 4; storage is not rewritten). Persistence
happens on the next write, which writes the current-version key and removes
older-version keys — one version per facet per object is an invariant. A
key *newer* than the registered version is preserved untouched and not
rendered, like an unknown facet: forward data is never destroyed.

### 8. Meaning, display, and display state are three layers

- **Payload** (meaning) is the only stored layer: validated, exported,
  CRDT-merged, queryable.
- **View specs** (display) live in the plugin definition, not in documents.
  The engine resolves payload × view spec × theme tokens into
  medium-neutral resolved values; renderers consume those. A view is a
  candidate on an object exactly when every facet it `reads` is present.
  Each display **slot** (outline, badge, body, canvas theme, …) has one
  active view; resolution order is session override → the persisted default
  (the `view` core field, value `{namespace}.{viewId}`) → namespace/view-id
  lexicographic order. Session overrides live in memory only.
- **Kinds are medium-exclusive.** Canvas kinds (`node-shape`, `icon-badge`,
  `node-figure`, `canvas-theme`, …) render as SVG inside canvas-render —
  which is itself a requirement, since anything rendered as an HTML overlay
  would vanish from `wb_scene_render`, PNG export, the widget and the
  viewer. Chrome kinds (`header-chip`, `list-adornment`, …) render as
  HTML/React per surface. No write-once widget abstraction spans the two —
  only resolved *values* and SVG assets cross the medium boundary.

Themes resolve the official-palette question without breaking the
colors-are-engine-tokens rule: a payload never carries raw styles; it
references a registered theme asset, which supplies token values (palette,
fonts, stroke style, edge and group styles).

### 9. Facet UI arrives only through contribution points

Existing surfaces expose named contribution points (`contextMenu.node.*`,
`canvasSettings`, `documentProperties`, …) and know no facet names.
Contributions are derived mechanically from definitions (targets + editor
spec + views); a definition cannot choose its placement. Layout policy —
native rows first, then facet rows in pure namespace order, per-point caps
with overflow folding into a "Facets…" entry — belongs to the point. Adding
a plugin changes zero UI files.

### 10. Editing is declarative, with the write path as the security boundary

Two tiers: an automatic form derived from the Zod schema (every facet is
editable with zero effort), and an optional declarative editor spec built
from the engine's widget catalog. Neither runs plugin code, so neither
needs an iframe sandbox — the enforcement point is the write path
(`wb_facet_set` + layer-4 validation), which every UI goes through. A
future editor that genuinely needs code reuses the existing MCP Apps
(ext-apps) sandboxed-iframe machinery rather than growing a second sandbox.
Registered definitions are also exposed over MCP so agents can construct
valid payloads; the MCP Apps widget stays read-only until the standing
"should the widget mutate documents at all" question is settled.

**2026-09-10, amended.** The paragraph above described two tiers and no
plugin code. What shipped was three, and the third ran a plugin's React
component in the composition root's own tree — `plugin-visual`'s symbol
editor, mounted by `apps/web`. This records what is true and what is
decided, because a design record that cannot describe its implementation
cannot be used to decide the next thing.

**What went wrong, and it was not the escape hatch.** The declarable
vocabulary was too thin to say what one facet needed. Glyphs were seven
silhouettes the core enumerated, and a control wrote ONE FIELD — while
`visual.symbol` offers twelve choices spanning both arms of a union, six of
them the plugin's own vendored geometry. Neither half was expressible, so
the facet took the only door left. The escape hatch then had no styling
contract, because a workspace package cannot use the app's utility classes
(Tailwind's content detection stops at the app, silently), so its component
drew the control by hand. Measured downstream: six spellings of "pick one
of N" across the app, four of them inside a single settings panel, and one
row that offered "no theme" twice.

So the ladder is repaired at the vocabulary, not at the hatch:

- **A facet-level `picker`** — one control writing whole PAYLOADS, with
  `payload: null` as the option that removes the facet. Arms stop
  mattering, and absence stops needing a second control beside the first.
  Every payload is parsed by the facet's own schema at `defineFacet` time,
  which a hand-written component never was: its options were checked only
  at the write boundary, so a typo shipped and read to a person as a choice
  that silently did nothing.
- **Glyphs closed in FORM, open in CONTENT** — `shape` (the enumerated
  silhouettes), `char` (one character or emoji), `asset` (a registered icon
  by id). A plugin still cannot ship an image or a component; it is no
  longer limited to seven shapes. Icon geometry travels as DATA through
  decision 3's `assets` layer, which is why it reaches every realm holding
  the registry — the picker, the canvas renderer, an export with no DOM.
  A component could only ever have drawn in one.
- **Primitives, not conventions, for the look.** `facet-ui` exports
  `FacetOptionGroup` / `FacetOption`, and they are the one drawing of a
  selection. This is `createFacetWriter`'s bargain applied to rendering: a
  plugin chooses what its options ARE and what order they come in, and does
  not choose what a selected option looks like, any more than it chooses
  what a valid payload is.

`component` survives as a real extension point with no bundled user — the
same deliberate shape as `RenderContribution.decorations` after the node
badge went. It is the contract with every plugin, not a convenience for
this one. Reaching for it stays the exception, and the reason is now
recorded rather than implied: what pushed the last user through it was the
vocabulary, so a next user is evidence the vocabulary is short again.

**2026-09-11, amended again — a picker may be OPEN.** The repair above made
a picker able to write any payload the plugin LISTED, and left one thing
unsayable: a facet whose schema accepts more values than a definition can
carry. `visual.symbol`'s emoji arm has accepted any single grapheme since
it shipped and the picker offered five, so the control said no to nineteen
hundred values the facet said yes to. Listing them was not the fix — a
facet definition is loaded wherever a document is READ (the SVG renderer,
the layout worker, the MCP server), and none of those draws a picker.

Two declarations close it, both data:

- **A `catalog`** — sections of options behind a `load()` the picker calls
  when it is drawn, so the rows can be a dynamic import and stay out of
  every graph that never opens one. The cost is honest and stated: these
  options are NOT parsed at `defineFacet` time the way listed ones are, so
  a plugin shipping a catalog owes its own test that every row parses.
  `plugin-visual` has one over all 1914.
- **Free `entry`** — a payload TEMPLATE plus the field the typed text
  fills. `{ payload: { kind: 'emoji' }, field: 'char' }` says what the text
  becomes without the plugin shipping a parser and without the engine
  learning what an emoji is. What a value may BE stays the schema's answer
  at the write boundary — which is the whole reason free entry can be
  offered at all: the control has no rule of its own and therefore cannot
  have a laxer one.

Definition time still checks what it can, and each check is a control that
would otherwise do nothing visible: a template already filling its own
field has two sources for one key, and a template the schema ALREADY
accepts writes the moment it is drawn, before anybody has typed.

The control that renders it is deliberately NOT a facet component.
`facet-ui`'s `CatalogPicker` takes loaded sections, a selected key and a
callback and knows nothing about facets; `FacetCatalogPicker` is the thin
adapter that loads what a definition declares and routes free entry through
`validateFacetWrite`. That split is the ladder's own principle applied one
level up: the vocabulary a plugin DECLARES is the facet system's, and the
control that draws it is a library any surface may use — the markdown
editor's `:name:` popup being the next one, over the same catalog rather
than a second copy of it.

## This increment

This ADR lands together with decision 2's mechanical half only: the key
grammar in `extensionFacetsSchema` (and every fixture that spoke the old
grammar). The rest lands in order: the plugin registry, four-layer
validation, compat chains, the canvas slot and the `visual` edge-style
migration; then `visual.shape/v0` (first node-target facet, resolving to
the already-landed silhouettes); then `visual.symbol/v0`; then the editor
tiers and contribution surfaces. `visual.text/v0` (per-node text
placement) landed after those and is the first facet to reach the editor
with NO composition-root change at all — its whole UI comes from the
tier-2 `editor` spec, which is the test of whether the tiers work.

**2026-09-08:** `visual.symbol/v0` widened from `targets: ['node']` to all
three. It was built for the surfaces where a thing is too small to read —
a document's favicon, a minimap — and reached only the node badge, which is
the one surface that does not need it. `targets` declares where a payload
may attach and is not itself payload, so decision 2's version rule does not
bite: the key stays `v0`, stored payloads keep their meaning, and no
migration exists to write. This is the growth rule in decision 1 read the
other way round — the same question ("what symbolises this object") asked
of more kinds of object is one facet, not three.

**2026-09-09:** the node badge is gone. Once the three surfaces existed, the
badge was drawing a mark on the one surface that can already show what it
marks — the node at full size, with its own content. `visual` therefore
contributes NO `decorations`, and `RenderContribution.decorations` is an
extension point with no bundled implementation: still typed, still exercised
by `contributed-decoration.test.ts` through fake contributions, and still the
way a plugin marks a node. Keeping the point while removing its only user is
deliberate — it is the contract between the renderer and every plugin, not a
convenience for this one.

**2026-09-09 (ADR-0030):** decision 8's "theme assets" exist now, as a
PREFIX of the layer it describes rather than the layer itself: a plugin
registers `assets.themes` (engine-owned token bundles, never raw style in a
payload), a facet declares `assetRefs` so a write naming an unregistered
asset is refused at the write boundary (decision 6's fourth layer), and
`visual.theme/v0` is the first facet to reach the `canvasSettings`
contribution point through the derived form alone. Views, slots and
per-kind resolved-value types stay unbuilt; [ADR-0030](0030-render-theme.md)
records the constraints that keep this a prefix.

**2026-09-10:** the `edge` target is open, and decision 5's third slot with
it. Two increments landed together. The pre-facet canvas-level
`x-whiteboard.edgeRouting` preference — the last of the "existing rendering
preferences" this decision promised to re-model — was RETIRED outright with
no compatibility read (0.0.x, no users), so `visual.edges/v0` is the only
place a board's routing lives. Then `visual.edges/v0` widened from
`targets: ['canvas']` to `['canvas', 'edge']`, on decision 1's growth rule
and the same reading that widened `visual.symbol`: "how is this drawn" asked
of a board and of one edge is one facet, not two. The key stays `v0` for the
reason that one did — `targets` declares where a payload may attach and is
not itself payload.

Precedence between the two scopes is FIELD BY FIELD, deliberately unlike the
replace-whole-payload rule WITHIN one scope: an edge saying only `routing`
is narrowing that one field, not declaring that the board's line jumps stop
applying to it. Decision 9's rule bit as written — a routing row hand-added
to the edge context menu would have been the linear extension the governance
line forbids — so the increment added the `inspector.edge` contribution
point (a core increment, as that decision says) and the tier-1 vessel now
takes a node or an edge as its subject.

## Consequences

- Extension metadata has a governed growth path: schemas are agreed by
  being registered, the `issue/1` accident class is structurally closed,
  and SaaS tenants get uniform per-plugin enable/disable — including the
  bundled plugin.
- The key itself carries provenance; nothing can pose as built-in, and
  ordering/collision rules have no special cases.
- Migration is a day-one capability, not a future invention: bumping a
  facet version means writing one function, and the read path already
  knows what to do with old data.
- Any document stored with old-grammar keys silently loses those facets on
  read. Accepted: the old grammar had no registered consumers and no known
  real data (its one convention was already retired).
- The engine's closed catalogs (kinds, widgets, points, tokens, targets)
  are the extension contract; growing any of them is an engine increment.
  That is deliberate friction — it is what keeps arbitrary code, arbitrary
  colors, and arbitrary placement out of other people's deployments.
- `readCoreFacets`'s spatial guard and `wb_facet_set`'s spatial refusal
  become target checks when the canvas/node slots land — the invariant
  "core facets never live on a spatial document" stays; the blanket "no
  facets on spatial" does not.

## Alternatives considered

- **Format-agnostic facets without registration** — rejected by ADR-0009,
  and the rejection held: unvalidated freedom is how `issue/1` happened.
  Adopted now only because distribution-time registration supplies the
  missing safeguard.
- **An unprefixed namespace for bundled facets** (`shape/v0`) — mirrors
  Kubernetes' core group, which Kubernetes itself treats as legacy; it
  would also re-create a privileged "core facet" class this design just
  removed.
- **Runtime user-defined facets** — the original wish, declined for
  governance: in SaaS/self-host the blast radius of runtime extension
  exceeds what a user can see. Runtime-variable vocabulary lives in
  payloads instead (workspace-target facets).
- **A write-once widget/component abstraction across SVG and HTML** —
  leaks structurally (canvas-render already needs its own text layout
  because SVG has no CSS layout); only resolved values cross the boundary.
- **Sandboxed iframes for the default editor tiers** — isolates trusted
  engine code from itself, breaks popover/focus UX, and misplaces the
  boundary: validation on the write path is what actually constrains a
  hostile editor.
- **Per-pair version converters** — N² growth; the stepwise compat chain
  is hub-and-spoke's linear special case.
