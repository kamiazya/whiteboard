# ADR-0027: Every picture of a document goes through one broker, and the cache is a memo

**Status:** Accepted — broker port, its in-tab implementation and the OPFS tier below all land. Every surface named below asks through it; the SharedWorker implementation remains a named follow-up

## Context

`apps/web` renders a document to SVG in several places — a list row's thumbnail,
the preview beside it, the editor's preview pane — and throws the result away
every time. Nothing caches it. What does exist is three mechanisms that are not
that:

| mechanism | holds | lifetime |
|---|---|---|
| `renderSceneToKeyedSvg` | keyed `<g>` groups for DOM patching | one mount, editor only |
| `contentCache` | one text node's laid-out body | worker lifetime, per theme |
| version thumbnail | a PNG of a saved version | durable, unrelated to live documents |

### What a render costs, measured before designing

`clusteredLayout` corpus, arithmetic measurer, warmed then 21 interleaved
rounds, median:

| document | layout + serialize | layout | serialize | warm `contentCache` | SVG |
|---|---|---|---|---|---|
| 12 nodes, 8 edges | 2.8 ms | 2.2 | 0.6 | 2.3 | 4.0 KB |
| 40 nodes, 34 edges | 32.8 ms | 29.8 | 3.0 | 31.5 | 13.2 KB |
| 120 nodes, 113 edges | 66.6 ms | 64.5 | 2.1 | 64.3 | 40.7 KB |

Two things follow, and both are the opposite of the obvious guess. Caching the
**SVG** is worth having not because serialising is expensive — it is 0.6–3 ms —
but because holding the string lets a caller skip the layout behind it. And the
`contentCache` that already exists returns 2–18% here, because edge routing
dominates and it memoises only text bodies. Cost is super-linear: 3.3x the
nodes cost 11.7x the time.

### The repeated work is real, and none of it is speculative

Three shapes, all confirmed in the source rather than imagined:

- A row's thumbnail and the preview pane beside it call the same loader
  independently, so selecting a row renders it a **second** time. There is no
  in-flight dedup between them.
- `loadRender` is memoised on `[source, resolvedTheme]`, so a dark-mode toggle
  re-renders every visible row.
- The result lives in component state, so leaving the list and returning
  rebuilds it.

### Markdown fell out of some surfaces, and nothing caught it

Markdown documents arrived after the thumbnail paths existed. The outline
family absorbed them — `useDocumentOutline` answers "a document's shape,
whichever kind it is", and the favicon and the tree row never branch on kind.
The SVG family never got the same treatment, and version thumbnails are worse
than kind-specific: the page uploads a PNG on every save, and `DocumentThumb`,
the only component that reads one back, is referenced by nothing but its own
test. Writes with no reader, for canvases only.

Prose does not hold that line. The worker pool's own doc comment lists a
favicon among the surfaces it serves, and the favicon has never gone through
it — a surface list written in a comment had already gone stale.

## Decision

### 1. One seam: a `RenderBroker` port, with the pool as its backend

Every surface that wants a picture asks the broker, which owns the memo, the
in-flight dedup and the priority. Today's worker pool becomes its backend
unchanged, so the change is additive rather than a rewrite. A daemon-rendered
future is another implementation of the same port, not a second path.

### 2. The key is a declared value type, and renderer identity comes from the build

The key crosses a worker boundary, which makes it a process boundary, which
makes it a Zod schema under this repo's existing discipline. A key assembled by
string concatenation at three call sites will disagree at two of them.

Renderer identity is a build-time constant compiled into the bundle, never a
hand-maintained version and never the service worker's update state. Under
`registerType: 'prompt'` a new worker installs while the page keeps running the
old bundle — a divergence this repo has already been bitten by (see
`.claude/rules/integrator-flow.md`). A key taken from the service worker would
say "v2" while v1's code writes the bytes, poisoning the new key with old
output, invisibly. A compile-time constant travels with the code that produced
the bytes and cannot drift from it.

Over-invalidation on a deploy that did not touch the renderer is accepted:
deploys are rare against page views, and precision would mean hashing the
render chunk — fragile, for little.

### 3. Kind is a parameter of the key, never a fork in the pipeline

Both kinds cache. One axis differs: spatial rendering bakes its palette while
markdown takes its ink from CSS, so **theme belongs in a spatial key and not in
a markdown one**. Markdown therefore caches harder, not less — one entry serves
both themes, and half of the measured dark-mode problem disappears from getting
the key right rather than from caching more.

### 4. Determinism makes this a memo, not a coordination problem

`renderSceneToSvg` is pinned byte-for-byte against the same committed golden
string in both the node and the browser test projects. Same key therefore means
same bytes, so two tabs racing to fill one entry is harmless — the loser of the
OPFS exclusive lock stops, because the winner is writing what it would have
written. **Cross-tab leader election is an optimisation, never a correctness
requirement.** That is what lets the SharedWorker implementation wait for
evidence instead of blocking the first increment.

### 5. Persistence is OPFS, the path is the invalidation strategy, and the tier lives in the worker

The key derives the path deterministically, with the build id leading, and
every component the keeper supplied is **encoded** — the document contract
declares `id` opaque and deliberately not pattern-bound, so a `/` in an id or
a timestamp would otherwise move the boundary between segments and let two
different documents join to one path. Verified rather than argued: unencoded,
`{id: 'a', version: 'b/c'}` and `{id: 'a/b', version: 'c'}` produce the same
string. The `~` prefix on each segment is what additionally makes `.` and
`..` impossible as whole segments.

```
render/~<buildId>/<pipeline>/<kind>/~<documentId>/~<versionKey>[-<theme>].json
```

The pipeline is part of the identity, not decoration. The broker holds one
map, so without it a tree row's outline and a list row's SVG name the same
entry — and whichever arrives first answers the other, in a type the caller
has no reason to check. It sits under the build id so a sweep can drop one
family the way it drops one build.

**JSON for both families**, which corrects this decision's first sketch. `.svg`
was right while an entry was imagined as the picture alone; what a caller
needs back is the whole worker reply — an SVG *and* the bounds a consumer
scales it to, or an outline's rectangles — and `layout`'s reply additionally
carries a `scene` and `anchors` that are not optional on it, so an entry
without them could not be served back as one. The family is still named by
its own path segment, which is what the extension was carrying.

Retiring a build's entire cache is removing one directory — no scan, no
scheduler, no index. Write-time is enough: when storing an entry, drop any
sibling directory that is not the current build.

**The tier lives in the WORKER, on both sides.** The realm assignment was
first argued from `createSyncAccessHandle`, which only a dedicated worker
has; the stronger reason is the read. Measured in a real browser, an OPFS
read costs 1.5-2.7ms — and a render already runs off the main thread, so
checking the cache on the *asking* thread would put ~2ms per row back onto
the very thread [#1275] and [#1293] spent their effort clearing. So the
request carries a `cacheKey` (the key's own path, absent when
`isMemoisableKey` refuses it), the worker answers from the store before it
works, and writes after. The stored value carries no `id` — an id belongs to
a request, not to a picture — so a hit is stamped with the asking request's
own, or the pool would be handed a reply addressed to a request it had
already settled.

### 5a. What is stored is decided by what the render cost, not by its pipeline

Persisting everything is a loss on the cheap end. Measured in a real browser,
medians of 15 interleaved rounds:

| case | payload | render | OPFS read | OPFS write |
|---|---|---|---|---|
| markdown, 4 sections | 3.1 KB | 7.4 ms | 1.9 ms | ~2.3 ms |
| markdown, 20 sections | 14.9 KB | **21.8 ms** | 2.2 ms | ~2.3 ms |
| markdown, 60 sections | 44.4 KB | **67.2 ms** | 2.3 ms | ~2.3 ms |
| spatial, 12 nodes | 2.6 KB | 2.0 ms | 1.7 ms | 2.6 ms |
| spatial, 40 nodes | 9.4 KB | 3.0 ms | 1.7 ms | 2.6 ms |
| spatial, 120 nodes | 28.8 KB | 7.2 ms | 2.1 ms | 2.7 ms |
| spatial, 400 nodes | 97.0 KB | 19.9 ms | 2.7 ms | 3.1 ms |

Two things follow, and neither was visible from the design.

**Text shaping is what persistence is for.** It grows superlinearly where an
OPFS read stays flat at ~2ms, so a list of twenty 20-section markdown rows is
436ms of worker time against 44ms of reads. **A small spatial canvas is a
loss**: 12 nodes saves 0.3ms and costs 2.6ms to store, so a naive
"persist everything" makes the first visit slower to buy nothing on the
second.

So the gate is a **floor on the measured render**, `STORE_FLOOR_MS = 5`, and
a floor rather than a per-pipeline rule because the cost is not a property of
the pipeline: a 400-node spatial canvas clears it and a four-section markdown
body barely does. Timing the work that actually ran stays true as either
pipeline changes.

The floor sits in a real gap rather than near either side. Measured warm
round-trips through the pool: a 12-node canvas is 3.4ms and a 20-section
markdown body 20.4ms. The first render of a session is not in that gap — a
cold layout measured 2477ms, almost all of it worker startup and WASM — and
storing it is correct: that render really cost that, and a list of twenty
rows pays it once rather than per row.

### 6a. Work nobody is waiting on says so, and the fleet believes it

`background` covered everything that was not the commit a person just made,
which put a list of thumbnails and a tab favicon on equal terms — so they won
worker slots by arrival order. A list is still something the user is looking
at; an icon that arrives a second late is not noticed at all. `idle` is the
band below, and the outline surfaces run in it.

The slot budget is over all the deferrable bands TOGETHER rather than one cap
per band, and that is correctness rather than tidiness: counted per band,
`idle` is free to take the very slot `background`'s cap reserves for an
interactive request. Measured on a two-worker fleet before the fix — an idle
request arriving between two background ones ran immediately, and both
background requests then waited.

### 6. A surface that draws a document is declared, or it does not compile

The surfaces are a table keyed by a union — the way this repo already pins its
background workers and its editor verbs — and each entry names the pipeline it
takes and the kinds it answers for. `kinds` is a `Record<DocumentKind, …>`, so
**adding a document kind fails the type check** until every surface has an
answer. That is the direction that actually broke, and it is the mechanical
half.

The surface direction is weaker, and saying so is part of the decision: a new
component that renders without asking the broker cannot be caught by a type,
only by a reader with this list in front of them. It is a list to review
against rather than a wall, and the honest alternative — a source scan for
"anything that draws a document" — has no reliable shape to match on.

## Consequences

Easier: a new surface that wants a picture has one place to ask and inherits
dedup, priority and (later) persistence; a new document kind cannot silently
miss a surface; the daemon-rendered and multi-tab futures are implementations
rather than paths.

Harder, and accepted: the key gains axes that must all be right, and a wrong
key is the worst failure this design can have — a stale picture that every test
still passes. That is why renderer identity is derived and why the theme axis
is stated per kind rather than applied uniformly.

Still open, and named rather than assumed:

- **The list surfaces' version key was measured, and it is weaker than this
  ADR first claimed rather than absent.** `writeWorkspaceDocumentContent`
  re-stamps a tree entry's `updatedAt` only when the projected content
  actually differs, and that is what a list row reads. Measured directly in
  `loro-adapter`: a content change moved the stamp (`...158` to `...168`) and
  a no-op write did not move it — which is exactly the property a cache key
  needs, and the opposite of what `documentEntrySchema`'s own comment ("when
  the placement last changed") suggests.

  Two real weaknesses remain, and only the second argues for a frontier:
  the field is OPTIONAL, so a row without one keys `version: null` and
  `isMemoisableKey` correctly refuses to remember it at all; and its
  resolution is one millisecond of the writing client's wall clock. An
  in-tab memo under a collided stamp dies with the tab. **A stored one does
  not**, which is the one thing persistence genuinely raises the bar on.
  Carrying a real frontier to `documentEntrySchema` / `documentSummarySchema`
  would close it and change nothing else — a four-layer contract change for a
  one-millisecond window, so it stays a named follow-up rather than a
  prerequisite.

  The OPEN document is no longer in that position: `DocumentSyncSession`
  answers `getFrontier()`, loro's own id for its committed state, and the
  favicon is keyed by it. Two things that took measuring rather than
  arguing, both recorded where the next reader will be:

  - the STATE frontier, not the oplog's — a document checked out to an older
    version shows that version, and the state frontier also does not move on
    a commit that changed nothing;
  - it names the COMMITTED state, which is deliberately not the instant the
    canvas is published. `onChange` publishes immediately and commits on a
    debounce, so a key read at render time files the new picture under the
    old version. `whiteboard:doc_changed` fires after the commit, and is
    therefore the trigger every surface keyed this way must use.
- **The fetch of a document's bytes is unmeasured** for the daemon keeper.
  For the browser keeper it is measured and `load-row-render.ts`'s claim that
  it dominates the wait is false — a near-constant 4-6ms against a render of
  9-29ms that grows with the document. The worker pool's cap of 4 rests on
  that claim and is worth revisiting.
- **Safari and iOS are unmeasured.** SharedWorker is expected absent, OPFS
  expected present. iOS is best-effort by standing policy, and the fallback is
  the in-tab implementation this ADR ships first.
- **The version-thumbnail PNG path is left alone here**, and the reason this
  ADR first gave for that was WRONG. Its read side is not dead: `VersionThumbnail`
  is rendered by `VersionTimeline`'s rows and by both panes of `MergeDialog`,
  and `attachVersionThumbnail` writes it from both document pages. (The claim
  confused it with `DocumentThumb`, a different component that really did have
  no call site and has since been deleted.) It is left alone for a caching
  reason instead: the picture is written once per save and read back as stored
  bytes, so there is no repeated render for a memo to join, and `png-raster`
  is deliberately outside `brokeredPipelineSchema`.

## Alternatives considered

**A Service Worker owning the cache.** It is killed when idle, so it hosts
neither coordination nor compute. It is also unnecessary for storage: `caches`
and `indexedDB` are present in every realm probed, including the SharedWorker.
It earns a place only once a daemon serves SVG over HTTP, where a real URL and
real cache headers exist.

**The Cache API as the store.** URL-keyed, storing Responses, against a tuple
key. Its payoff would be serving `<img src>` through a service worker, and
markdown thumbnails cannot be images — they inherit their ink from page CSS.

**A SharedWorker owning the worker fleet.** Measured impossible: a SharedWorker
has no `Worker` constructor (`Worker is not defined`). The realm probe, run in
Chromium against the repo's own font loader and measurer:

| realm | `Worker` | `SharedWorker` | `indexedDB` | `caches` | `navigator.locks` | OPFS `getDirectory` | `createSyncAccessHandle` |
|---|---|---|---|---|---|---|---|
| window | yes | yes | — | yes | yes | yes | no |
| dedicated worker | yes | no | yes | yes | yes | yes | **yes** |
| SharedWorker | **no** | no | yes | yes | yes | yes | no |

The font pipeline itself does work in every realm, which is what made the
SharedWorker worth probing at all: `ensureViewerFontLoaded` +
`createBrowserMeasureText` reported `loaded` and an identical 277.578125 px
advance in all three. The control in that measurement is what makes it
evidence — the SharedWorker's *fallback* font differs from the other two
(296.578125 vs 268.5078125), so a Roboto match to the bit is the registered
face being applied, not a coincidence of falling back to the same thing.

**PNG thumbnails.** A row and the preview are the same SVG at two sizes, so a
raster serves neither well. The one surviving PNG path is an Excalidraw-era
contract that outlived its exporter: the app renders its own SVG and then
rasterises it through an `<img>` and a canvas purely because the storage
contract says PNG.
