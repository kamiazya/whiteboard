---
name: loro-crdt-usage
description: How this repo uses loro-crdt correctly — mergeable child containers vs the deprecated getOrCreateContainer, what a container choice costs in oplog bytes, rich-text marks, and how to measure a Loro claim against the installed version instead of trusting a doc page. Use when adding or changing anything that opens a container, stores a collection, exports/imports a document, or when a CRDT merge is losing data.
---

# Using loro-crdt in this repo

Loro is where this project's data actually lives, and its failure mode is
the worst kind: **a wrong container choice loses data with no conflict, no
error, and both replicas agreeing on the truncated result.** Nothing goes
red. The loss is found, if ever, by a person noticing their reply is gone.

So the rule here is the repo's rule everywhere else, sharpened: **a claim
about Loro is worth what its measurement is worth.** The version is pinned
in `pnpm-workspace.yaml` (`loro-crdt: "1.13.6"`), the API has changed
under this repo more than once, and `loro.dev` is not reachable from this
environment anyway. What IS reachable and authoritative is shipped inside
the package — see "Where the answers actually are" below.

## The rule: a lazily-created child container must be mergeable

`map.getOrCreateContainer(key, new LoroMap())` mints a **regular op-id**
child. Two replicas that each open the same key having never seen the
other's end up with two containers, and the map's conflict resolution keeps
one and hides the other.

Measured on 1.13.6 — two peers, no common ancestor for the key, each
writing one entry:

| opened with | both replicas read |
|---|---|
| `getOrCreateContainer` | `{"fromB": "reply B"}` |
| `ensureMergeableMap` | `{"fromA": "reply A", "fromB": "reply B"}` |

Same for `ensureMergeableText` (`"ab"` vs `"b"`) and
`ensureMergeableMovableList` (`["A","B"]` vs `["B"]`).

loro-crdt says so itself. 1.13.0's changelog: *"`getOrCreateContainer` is
deprecated for lazy map-child creation; migrate those call sites to
`ensureMergeable*`."* A mergeable child lives at a deterministic
`ContainerID` derived from `(parent, key, kind)`, so the two peers were
editing one container all along.

**Use `openMergeableMap` / `openMergeableText` /
`openMergeableMovableList` from
`packages/loro-adapter/src/mergeable-containers.ts`**, never the raw
method. Four things the helper exists for, each measured:

1. **`ensureMergeable*` THROWS on a key that already holds a non-mergeable
   value** — `Cannot create a mergeable Map at key "k": the key already
   holds a non-mergeable value`. That is every document written before the
   helper landed, so a bare swap breaks stored data. The helper takes the
   mergeable branch only for an ABSENT key and leaves an occupied one
   exactly as it was, which is what makes this safe with no migration.
2. **They live on `LoroMap` alone.** Not on `LoroList`, `LoroMovableList`
   or `LoroTree` — which is the shape of the problem, not an omission: a
   list position is already a unique op, so only a map KEY needs two peers
   to agree on which child it names.
3. **A mixed pair still loses one side.** One replica opening the key the
   old way while another opens it mergeable converges on the mergeable one.
   The fix removes the hazard for containers created from here on; it
   cannot repair a fork that already happened.
4. `getOrCreateContainer` reading a container `ensureMergeable*` created is
   fine, so a reader on an older code path is not broken by the switch.

## What it costs, and where this repo therefore does NOT use it

A mergeable child's id is deterministic rather than an op id, and every
write into one encodes that. Measured against
`workspace-record-growth.test.ts` with the whole package switched over:

| scoreboard | regular | mergeable | delta |
|---|---|---|---|
| one document, no edits | 919 B | 1069 B | +16.3% |
| 10 documents x 100 edits (delta log) | 178560 B | 211860 B | +18.6% |

**Attributed, not assumed**: reverting `workspace-tree.ts` alone put every
number back, so the entire cost is the per-document CONTENT containers and
the thread plane's share of it is zero.

Which settles where it goes. A document's content containers are
pre-attached by whoever creates the document (`attachContentContainers`
over `CONTENT_CONTAINER_KEYS`), so they ride the op log and no second
replica ever opens one first — the hazard is already closed there, and
18.6% of the delta log is paid by the compaction subsystem forever. A
thread's key is **the caller's comment id** and nothing pre-attaches it, so
there the hazard is real and the cost is nil.

`mergeable-containers.test.ts` keeps that a decision rather than a habit:
every remaining regular call is registered with a reason and a pinned
count, so a new lazily-created container fails the suite until someone
answers which kind it is.

## Where the answers actually are

`loro.dev` and `deepwiki.com` are blocked by this environment's egress
proxy. Do not build a claim on a search-result summary of them. The
reachable, version-exact sources are all inside the installed package:

```bash
D=$(dirname $(node -e "console.log(require.resolve('loro-crdt/package.json'))"))
sed -n '/getOrCreateContainer/,+20p' "$D"/nodejs/loro_wasm.d.ts   # the deprecation, in full
grep -i -B4 -A10 mergeable "$D"/CHANGELOG.md                       # when and why it changed
```

The typings carry the semantics no summary does — that activation writes a
binary marker into the parent map slot, that a different `ensureMergeable*`
kind at a live key is a deliberate kind change, that deleting the key hides
the child but preserves its state and re-ensuring resurfaces it.

## Measuring a Loro claim

Put the probe where `loro-crdt` resolves. Node resolves bare specifiers
from the SCRIPT's directory, so a script in `tmp/scripts/` fails with
`ERR_MODULE_NOT_FOUND` however you invoke it; write it under
`packages/loro-adapter/` and delete it after, or better, write it as the
test it is about to become.

**Calibrate the instrument first.** `doc.version().toJSON()` answers `{}`
in 1.13.6, so a probe built on it reports "no ops emitted" for a write that
definitely emitted one — which reads as a finding. `doc.frontiers()` is the
one that moves:

```js
const fr = (d) => JSON.stringify(d.frontiers())
const before = fr(doc); doc.getMap('m').set('a', 1); doc.commit()
console.log('a write moves the frontier:', before !== fr(doc))  // must be true
```

That calibration caught a wrong conclusion here: opening a container LOOKED
free, and it is an op on both a root map and a tree node's data map. The
`attachContentContainers` rationale in `loro-bridge.ts` stands because of
it.

The standing shape for a convergence question — used by
`comment-threads.convergence.test.ts` — is two peers with **a common
ancestor that does not contain the key**, each writing something the other
cannot produce, then importing both ways. Assert on the merged content of
both replicas; "they converged" alone passes when both converged on the
loss.

## What this repo already does right

Do not rediscover these; they are wired and tested.

- **Batching.** `withSpatialBatch` owns the commit boundary for a user
  action. A write helper called under it must not commit — an extra commit
  splits one action into two undo steps. That is why `comment-threads.ts`
  has both `writeCommentThread` (commits) and `writeThreadInto` (does not).
- **Export modes.** `mode: 'update'` with a `VersionVector` for the
  incremental path, `'snapshot'` for stored state, `'shallow-snapshot'`
  with a frontier for compaction (`document-store.ts`). The delta log is
  what the scoreboard above prices.
- **Rich-text marks.** `configureTextStyle` REPLACES the config rather than
  adding to it, so the complete set is configured at once —
  `markThreadPassages` derives it from every thread it can see, so no call
  site can forget. A mark belongs to the CHARACTERS: it follows edits and
  vanishes with its passage, which is why `writeMarkdownBody` splices
  minimally instead of rewriting the body.
- **Undo/redo needs 1.13.6.** 1.13.6 fixes *"undo/redo restoring mergeable
  map children as regular non-mergeable containers"*. This repo runs an
  `UndoManager`, so the mergeable path and that floor travel together.
