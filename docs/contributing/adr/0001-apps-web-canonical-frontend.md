# ADR-0001: apps/web as the canonical frontend

**Status:** Implemented — Stage 5 (deleting `packages/mcp-server/src/app` and its build pipeline) shipped; server-mode serves a minimal static placeholder at its root instead of `apps/web` (see Consequences).

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
- The daemon is simplified to backend-only concerns; its `src/app` UI is deleted.
- Server-mode (OAuth/JWT auth) serves a minimal static placeholder at its root rather than `apps/web`: apps/web's provider model only knows browser-local and local-daemon-bearer-token auth, and injecting it without a real token would 401 on every request. A server-mode-aware `apps/web` auth flow is a separate follow-up.
- The `CanvasBackend` interface is an intentionally hand-written behavioral seam (methods and callbacks) for in-process use; it is not a JSON shape that crosses a process boundary. The payload field types it references are derived from `z.infer<>` in `ws-messages.ts` per the Zod-schema discipline, so there is no parallel re-declaration of those shapes.
- Excalidraw enters the `apps/web` bundle; the bundle size must stay within the project's performance budget.

## Alternatives considered

**Shared UI package** — Extract common components into a third workspace package. Rejected: adds build/dependency complexity with no benefit for a single canonical app target.

**Keep daemon-served UI as canonical** — Continue treating `packages/mcp-server/src/app` as the primary frontend and treat `apps/web` as secondary. Rejected: contradicts the goal of a statically deployable frontend independent of the daemon process.

**One-shot migration** — Replace both UIs in a single PR. Rejected: too wide a regression surface; staged approach keeps each increment verifiable.

## Addendum (2026-08-08): the daemon serves /pair only

The original decision left the daemon "optionally serving the static build
of `apps/web`" as a convenience fallback. That option is now retired
(maintainer decision, 2026-08-08): the local daemon serves exactly one page —
`/pair`, the pairing consent trust anchor that must come from the daemon's
own origin (see ADR-0005 and the daemon identity keypair design) — plus the
static assets it needs. Every other UI path answers a 302 to the official
hosted app, and daemon startup auto-open targets the hosted app as well.

Rationale: with the official hosted origin admitted by the daemon by
default and pairing grants persisting across restarts, the hosted PWA is
the canonical entry for every flow, and a second fully-functional origin
was a source of divergence (duplicate SW/PWA behavior, split user state,
double security surface). Accepted tradeoff, explicitly: a fully-offline
FIRST run (PWA never installed) has no canvas UI — the installed PWA is
the offline path.

The `dist/web-app` copy step and its packaging checks remain: `/pair` is
rendered by the same built bundle.
