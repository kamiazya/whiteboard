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
  format contributes `canvas` and `node`; `edge` reserved. A future format
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
