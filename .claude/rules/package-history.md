---
paths:
  - "packages/history/**"
---

# history — a document's history as pure mechanics over the workspace record

## Why it is its own package

A saved version is a FRONTIER of the workspace record; a checkpoint is a
debounce over "this document changed"; retention is arithmetic over a list of
rows. None of that knows where a row lives — and where the rows live is the
only thing the two keepers differ in. The daemon had all of it, mixed into the
same files as its SQLite reads, its per-workspace lock and its websocket
broadcast, so the browser keeper could not have checkpoints without writing a
second copy. This package is the first copy, moved, so there is never a second.
Both keepers import it today (`mcp-server`'s `version-store.ts` and
`routes/document/auto-version.ts`; `apps/web`'s `browser-version-store.ts` and
`use-auto-checkpoint.ts`), which is the claim being made and the reason it
holds.

`loro-adapter` could not hold it (it is the LoroDoc<->model bridge) and
`workspace-index` is the `DocumentIndex` port over the tree — placement, not
history.

## What belongs here

Three modules, and `src/index.ts` is the whole published surface:

- `checkpoints/scheduler.ts`: the trailing debounce with a ceiling, over an
  injected `save`. `CHECKPOINT_QUIET_MS` (5min) and `CHECKPOINT_CEILING_MS`
  (30min) are the cadence both keepers share, which is the point of them
  living here rather than twice.
- `checkpoints/retention.ts`: which automatic checkpoints may go —
  `autoVersionsOverCap` over `MAX_AUTO_PER_DOCUMENT` sparing lineage, and
  `sandwichedAutoVersionIds` for the run between two manual saves.
- `frontiers-base64.ts`: frontiers as text, over `atob`/`btoa` so no keeper
  reaches for `Buffer`.

## What does NOT belong here

- Rows, locks, broadcasts, blobs. The daemon's read-modify-write under its
  workspace lock, the browser's write queue, a thumbnail `unlink` — each
  keeper wraps a pure step here in its own.
- Where a checkpoint goes. The scheduler takes `save` and `onError`; it has
  no logger and no store.
- The wire. Request and response schemas stay in `daemon-client`.

## What used to be here

Branch (variation) operations and merge planning lived here — a branch
schema, create/delete/setHead/rename over a mergeable plane of the workspace
record, and a merge engine that computed a per-peer meet of two version
vectors. [ADR-0029](../../docs/contributing/adr/0029-proposals.md) retired the
branch in favour of the proposal, and all of it was deleted. Nothing replaced
it inside this package: a proposal follows the document rather than fixing a
point in time, so it needs no frontier arithmetic of its own.

This paragraph is past tense on purpose. The rule described that surface in
the PRESENT for as long as it has been gone, across 22 of its 99 lines, and
auto-loaded it into every session that opened the package — which is what
widening `comment-file-pointers.test.ts` to read `.claude/**/*.md` caught,
eleven pointers at once.

## Dependency rules

- Runtime: `loro-crdt`, and nothing else. Not `model`, not `zod` — the three
  modules take plain rows and `Frontiers`, so there is no schema to own.
- Forbidden: `node:*`, DOM globals, `inversify` — it runs in both roots and a
  worker. `Buffer` is the one that was here before the move; the base64 codec
  is what replaced it.
- Enforced by `tools/arch-lint`; listed in `repo-coverage.test.ts`'s
  `SHARED_LAYER_PACKAGES` so the scan reaches it (registration alone does not
  scan, see `package-workspace-index.md`).

## Conventions

- **A mechanic answers a decision, never performs it.** `autoVersionsOverCap`
  returns ids to delete; the caller deletes. A function here that took a store
  would be the daemon's store again, one package down.
- **The scheduler's timer is a browser timer.** `unref` is guarded because it
  does not exist there; nothing else in this package may assume Node.

## Tests

- Vitest project: `history-node`. `scheduler.test.ts` runs the cadence under
  fake timers; `retention.test.ts` pins the cap and the sandwich;
  `frontiers-base64.test.ts` carries the round-trip property
  (`src/test-utils/fast-check.ts` holds its arbitrary).
- The keeper-facing behaviour — that a checkpoint actually lands, that
  retention deletes the right rows — stays where each keeper's store is.
