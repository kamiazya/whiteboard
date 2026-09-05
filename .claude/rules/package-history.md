---
paths:
  - "packages/history/**"
---

# history — a document's history as pure mechanics over the workspace record

## Why it is its own package

A branch (a variation, ADR-0022) is a name and a FRONTIER of the workspace
record; a saved version is a frontier too; a merge is three projections of
the record and a diff between them; a checkpoint is a debounce over "this
document changed". None of that knows where a row lives — and where the rows
live is the only thing the two keepers differ in. The daemon had all of it,
mixed into the same files as its SQLite reads, its per-workspace lock and its
websocket broadcast (`branches-store.ts`, `branch-merge.ts`, `auto-version.ts`,
`version-store.ts`), so the browser keeper could not have branches without
writing a second copy. This package is the first copy, moved, so there is
never a second.

`loro-adapter` could not hold it (it is the LoroDoc<->model bridge and stays
closed to "what a branch is"), and `workspace-index` is the `DocumentIndex`
port over the tree — placement, not history.

## What belongs here

- `branches/schema.ts`: `branchMetaSchema` / `documentBranchesStateSchema`,
  the ONE definition of a branch; `daemon-client`'s `/branches` contract
  re-exports them. `main` is the default variation every keeper knows.
- `branches/ops.ts`: create / delete / setHead / rename / updateBranchTip as
  pure functions over the state, answering `{ next, result }` and throwing the
  two typed errors. `next: null` means "nothing to write".
- `merge/merge-engine.ts` + `merge/plan-merge.ts`: the advisory badges, the
  merge base (per-peer meet of two version vectors), and everything a merge
  decides before anything is written. Tip adoption, "source wins": the source
  tip IS the preview.
- `checkpoints/scheduler.ts`: the trailing debounce with a ceiling, over an
  injected `save`. Its constants are the cadence both keepers share.
- `checkpoints/retention.ts`: which automatic checkpoints may go — over the
  cap sparing lineage, and the sandwich between two manual saves.
- `frontiers-base64.ts`: frontiers as text, over `atob`/`btoa` so no keeper
  reaches for `Buffer`.

## What does NOT belong here

- Rows, locks, broadcasts, blobs. The daemon's read-modify-write under its
  workspace lock, the browser's write queue, a thumbnail `unlink`, a
  `sendHeadChanged` — each keeper wraps a pure step here in its own.
- Where a checkpoint goes. The scheduler takes `save` and `onError`; it has
  no logger and no store.
- The wire. Request and response schemas beyond the branch itself stay in
  `daemon-client/api-contracts/branches.ts`.

## Dependency rules

- Runtime: `model`, `loro-adapter`, `loro-crdt`, `zod`.
- Forbidden: `node:*`, DOM globals, `inversify` — it runs in both roots and a
  worker. `Buffer` is the one that was here before the move; the base64 codec
  is what replaced it.
- Enforced by `tools/arch-lint`; listed in `repo-coverage.test.ts`'s
  `SHARED_LAYER_PACKAGES` so the scan reaches it (registration alone does not
  scan, see `package-workspace-index.md`).

## Conventions

- **A mechanic answers a decision, never performs it.** `planMerge` returns
  the preview and the ids; `autoVersionsOverCap` returns ids to delete. The
  caller writes. A function here that took a store would be the daemon's
  store again, one package down.
- **Errors are typed, and the keeper maps them.** `UnreadableBranchTipError`
  names the branch and the detail; the daemon turns it into its
  `corruptStoredData`, the browser into whatever its degraded view reads.
- **The scheduler's timer is a browser timer.** `unref` is guarded because it
  does not exist there; nothing else in this package may assume Node.

## Tests

- Vitest project: `history-node`. `merge-engine.test.ts` carries its
  fast-check properties over `spatialCanvasArbitrary`; `ops.test.ts` pins the
  rules (`main` immovable, HEAD undeletable, rename follows HEAD and
  `baseBranch`); `scheduler.test.ts` runs the cadence under fake timers.
- The keeper-facing behaviour — that a stored tip checks out after
  compaction, that a merge reconciles the live document — stays where each
  keeper's store is: `mcp-server`'s `compact-branch-pin.test.ts` and
  `branch-merge.test.ts`, and the browser's contract runs once it has
  branches.
