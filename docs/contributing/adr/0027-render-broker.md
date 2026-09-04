# ADR-0027: Every picture of a document goes through one broker, and the cache is a memo

**Status:** Accepted — broker port and its in-tab implementation land with this ADR; OPFS persistence and the SharedWorker implementation are named follow-ups

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

### 5. Persistence is OPFS, and the path is the invalidation strategy

The key derives the path deterministically, with the build id leading, and
every component the keeper supplied is **encoded** — the document contract
declares `id` opaque and deliberately not pattern-bound, so a `/` in an id or
a timestamp would otherwise move the boundary between segments and let two
different documents join to one path. Verified rather than argued: unencoded,
`{id: 'a', version: 'b/c'}` and `{id: 'a/b', version: 'c'}` produce the same
string. The `~` prefix on each segment is what additionally makes `.` and
`..` impossible as whole segments, which matters before the store exists
rather than after.

```
render/~<buildId>/<kind>/~<documentId>/~<versionKey>[-<theme>].svg
```

Retiring a build's entire cache is removing one directory — no scan, no
scheduler, no index. Write-time is enough: when storing an entry, drop any
sibling directory that is not the current build.

The realm assignment follows a probe rather than a preference: only a
**dedicated worker** has `createSyncAccessHandle`, and that is also where the
bytes are produced, so the renderer persists its own output with no extra hop.

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

- **Persistence needs a version key that does not exist yet.**
  `documentSummarySchema` carries no frontier. `updatedAt` is stamped per push
  in practice but is optional in the schema, and a key with no version cannot
  notice its document changing — so `isMemoisableKey` refuses to remember a
  completed render under one, and only the in-flight join applies there. That
  is the honest behaviour rather than a limitation to work around: a memo
  under such a key would serve the old picture for as long as the tab is open.
  Adding the frontier is its own increment, and until it lands the broker
  caches in memory only.
- **The fetch of a document's bytes is unmeasured**, and `load-row-render.ts`
  claims it dominates the wait. If that is true, the cache's largest win is
  skipping the fetch rather than the CPU — which does not change this design,
  but does change how its benefit should be reported.
- **Safari and iOS are unmeasured.** SharedWorker is expected absent, OPFS
  expected present. iOS is best-effort by standing policy, and the fallback is
  the in-tab implementation this ADR ships first.
- **The version-thumbnail PNG path is left alone here.** Its read side is dead,
  so the question is whether the feature exists at all, and that is a product
  decision rather than a caching one.

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
