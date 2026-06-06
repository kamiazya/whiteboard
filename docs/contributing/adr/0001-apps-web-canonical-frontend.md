# ADR-0001: apps/web as the canonical frontend

**Status:** Accepted

## Context

The repository had two parallel frontend implementations:

- `packages/mcp-server/src/app` — the original Excalidraw-based canvas UI served directly by the daemon (fully functional: real-time sync via WebSocket, IndexedDB fallback, storage management).
- `apps/web` — a separate Cloudflare Pages app that was a degraded scaffold (83-line canvas page, no Excalidraw, no sync).

The two apps shared no code. The daemon served its own UI and had no integration with `apps/web`. The project is 0.0.x with no external users, so backward compatibility is not a constraint.

## Decision

Consolidate the frontend into `apps/web` as the single canonical app. The daemon becomes a pure backend (MCP tools + WebSocket sync + persistence), optionally serving the static build of `apps/web` but no longer owning a UI of its own.

The migration proceeds in stages so each stage ships as a working increment:

1. Extract a `CanvasBackend` interface from `useWhiteboardSync`, encapsulating the current WebSocket+REST behavior as `DaemonBackend`.
2. Migrate the full editor (`CanvasPage`, `useWhiteboardSync`, `storage-provider` seam) into `apps/web` and produce a static build.
3. Implement `BrowserLocalBackend` (offline Loro doc persisted to IndexedDB) so `apps/web` works without a daemon.
4. Wire `apps/web` to a local daemon over Local Network Access when available; fall back to `BrowserLocalBackend` when not.
5. Remove the daemon's UI-serving code and deduplicate the remaining overlap.

## Consequences

- `apps/web` can be deployed as a static site (Cloudflare Pages, any CDN) and works offline via `BrowserLocalBackend`.
- The daemon is simplified to backend-only concerns; its `src/app` UI is removed after migration.
- Stages 1–5 are non-trivial; the daemon UI remains live until Stage 2 completes.
- The `CanvasBackend` interface becomes a Zod-guarded contract (no hand-written parallel type).
- Excalidraw enters the `apps/web` bundle; the bundle size must stay within the project's performance budget.

## Alternatives considered

**Shared UI package** — Extract common components into a third workspace package. Rejected: adds build/dependency complexity with no benefit for a single canonical app target.

**Keep daemon-served UI as canonical** — Continue treating `packages/mcp-server/src/app` as the primary frontend and treat `apps/web` as secondary. Rejected: contradicts the goal of a statically deployable frontend independent of the daemon process.

**One-shot migration** — Replace both UIs in a single PR. Rejected: too wide a regression surface; staged approach keeps each increment verifiable.
