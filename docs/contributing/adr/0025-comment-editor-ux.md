# ADR-0025: Comment editor UX — lifecycle, visibility, identity, and AI delivery

**Status:** Accepted

## Context

ADR-0024 shipped the comment layer's data model, per-comment CRDT storage,
scene-composed rendering, `wb_canvas_edit` ops (`comment.add` /
`comment.resolve` / `comment.remove`), snapshot exposure, and the MCP Apps
widget's click-to-anchor + `sendMessage` flow (PRs #1204–#1212). It
explicitly deferred the apps/web editor's interactive UI.

Building that UI forces decisions ADR-0024 did not take, and taking them
piecemeal risks a stored-shape migration later or an editor that promises
things the system does not do (a comment "sent to the AI" that no AI was
told about). A multi-perspective design pass (product / UX / architecture /
security / prior-art research over Figma, Miro, Google Docs, Linear) was run
first; the human decisions below were taken on 2026-09-02 with the full
option set in front of the user.

Two facts frame every choice:

- **Zero real usage evidence exists** for editor comments — the editor has
  never had a create path — so every speculative surface (threads, identity,
  push notification, dense-canvas clustering) would be built on argument
  alone. This repo's standing rule is instrument first, and here the
  instrument is a shipped minimal lifecycle loop plus dogfooding.
- **Stored-shape changes are cheap now** (0.0.x, no external users, and
  `canvasCommentSchema`'s optional fields are additive), so pre-provisioning
  structure "for SaaS" buys nothing that adding it later would not.

## Decision

### 1. Creation enters through the context menu, and only there (v1)

- Node band: **"Comment on this"** — creates with `targetNodeId`, anchored
  by the existing top-right-corner rule. This verb is exempt from the
  locked-node collapse-to-Unlock-only precedent, explicitly: a comment does
  not mutate the node.
- Empty-canvas band: **"Comment here"** — creates at the clicked canvas
  point.
- Both open an **inline, anchored, non-modal compose bubble** (autofocus
  textarea; Enter/Add commits, Esc cancels; a failed write keeps the text
  and the anchor). An optional `C` shortcut may accompany the menu verbs,
  but the menu is the discoverable path and the keyboard path exists
  regardless of pointer (accessibility floor).
- A comment TOOL (Figma-style mode) is rejected for v1: it adds a tool-mode
  state machine and a dock surface for no evidence-backed gain. Revisit only
  with dogfooding evidence that menu entry is too slow.

### 2. Resolved comments are a show/hide toggle, not a panel (v1)

- One toggle — "Show resolved" — wired to a `showResolved` layout option in
  `composeComments`. ON draws resolved pins/bubbles (visually muted per the
  theme), each individually reopenable.
- The toggle's state is **per-user local view state, never written to the
  shared CRDT document** — a future multi-user keeper must not let one
  person's toggle change what another person sees.
- A persistent Comments panel (list + jump-to) is the named upgrade if
  dogfooding shows the toggle insufficient on dense canvases. It is not
  built now; the keyboard-reachable create/resolve paths carry the
  accessibility requirement the panel would otherwise have carried.
- Resolve/reopen ship with **no confirmation dialog** (resolve is reversible
  by design — ADR-0024 keeps the record) and a toast with Undo. A failed
  resolve/reopen write keeps the bubble's visible state unchanged and says
  so in the toast — the pin never optimistically flips to a state the
  document does not hold.
- `comment.remove` stays an MCP-op-only affordance in v1. The editor ships
  resolve-only, matching the ticketing rule one level down: deletion is for
  a comment that was never worth keeping, and the editor should not make
  destroying the conversation easier than closing it.

### 3. Comments ship authorless in the editor (v1)

The editor writes no `author`. The field already carries OKF actor strings
(`human:` / `process:`, ADR-0016) written by MCP clients, so AI-authored
comments are already distinguishable where an author exists; a real identity
model arrives with a keeper that can vouch for one (SaaS/daemon accounts).
Minting a browser-local display label now was considered and rejected: it
would de facto reverse ADR-0016's refusal to mint local identity, and a
label nobody can trust is worse than an honest blank. When identity lands,
it fills an optional field — no migration.

### 4. AI delivery is pull-by-convention (v1); no new push surface

- The documented convention: **an AI collaborator sees new and resolved
  comments on its next `wb_canvas_snapshot` read** (the snapshot already
  returns all comments, resolved included). A how-to records this so agent
  authors build the habit of checking open comments.
- Editor copy must never claim real-time AI delivery — "Comment saved",
  never "sent to the AI". The MCP Apps widget's `sendMessage` remains the
  one proven push channel and keeps its wording.
- MCP `resources/subscribe` (or any push/notification machinery) is out of
  scope pending a client-support verification, filed as its own follow-up.
  Security's position is recorded: a new delivery mechanism is new attack
  surface and gets its own threat-model pass when it comes.

### 5. Comment chrome stays out of `sceneDigest`

The editor needs hit-testable pin/bubble geometry, which means those shapes
gain ids (suffixed, mirroring the shipped `${commentId}/leader` convention:
`/pin`, `/bubble`). `sceneDigest` reports one entry per addressable node id,
so without a rule those ids would surface comments as phantom nodes in
`wb_scene_digest` — repeating the three-nodes/six-entries mistake the
digest's design note records, and double-reporting what
`wb_canvas_snapshot.comments` already publishes. Decision: **suffixed comment
chrome ids are excluded from the digest's addressable set**, pinned by a
test, so the digest keeps answering "what content is on this canvas".

### 6. Editor writes ride the fine-grained path, gated before any UI

`document-sync-session.ts`'s command fallback commits a whole
`writeSpatialCanvas` resync, which deletes any comment id not present in the
in-memory canvas — exactly the concurrent-loss failure ADR-0024's
per-comment map exists to prevent. Every comment `EditorCommand` therefore
gets an explicit fine-grained write case (via the bridge's
`writeCanvasComment` / `deleteCanvasComment`), and a property test pins that
two peers writing different comments concurrently both survive. This lands
as a spike BEFORE any UI slice, because a UI wired to the fallback would
look correct in every single-user test.

### Explicitly deferred (each needs evidence, not argument)

| Deferred | Trigger to revisit |
|---|---|
| Threads / `parentId` replies | dogfooding shows single-text comments forcing awkward node-edit conversations |
| Identity minting / per-author styling | a keeper that can vouch for identity (daemon accounts / SaaS) |
| Push notification to AI (`resources/subscribe` etc.) | client-support verification + a real latency complaint against pull |
| Dense-canvas collision avoidance / clustering | dogfooding pain at real comment densities (the fixed-offset ponytail stands) |
| Resolve/remove authorization (author-only? role?) | real identity; named here so it is not decided by omission — today's boundary is "anyone with document write access" |
| Comments panel / history surface | toggle proves insufficient on dense canvases |
| `text` length cap + snapshot truncation treatment | first oversized-comment incident or measured snapshot bloat |

## Consequences

- The v1 loop is create → read → resolve/reopen, entirely inside the editor,
  with resolved history one toggle away — and nothing in it writes a shape
  that a later identity, thread, or notification feature would have to
  migrate.
- Editor UI slices route their interaction tests to `web-browser` (pointer /
  keyboard / focus behavior — jsdom alone is disallowed by AGENTS.md for
  interaction), with race cases stated per slice: a compose bubble whose
  anchor node is deleted by a remote peer mid-edit keeps the draft and falls
  back to the point anchor; a resolve/reopen whose bubble unmounts mid-write
  still lands or reports failure via toast.
- User copy vocabulary: the feature is a **Comment** (the layer name
  "annotation layer" stays an internal term), and the lifecycle word is
  **Resolved** — never "History", "Archived", or "Done".
