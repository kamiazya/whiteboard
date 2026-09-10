---
paths:
  - "packages/mcp-server/**"
---

# mcp-server — the Node composition root (CLI, daemon, stdio, local stores)

Placement and boundaries are `architecture-map.md`'s (a composition root:
allowed `node:*`, DOM-free, inversify; never imported by a shared package).
This file carries what a session editing the daemon has to know that no
scan says.

## Tests

- **Every HTTP route the daemon registers is fuzzed from its own schema**
  (`server/app.routes.fuzz.property.test.ts`), the sibling of server-core's
  `/api/v1` lane over everything else `createApp` mounts. Routes are read
  off `app.routes`; the three wildcard patterns dispatch on the URL's tail,
  so their actions are read off the `onDocumentAction` /
  `onDocumentFile` / `onDocumentsRoute` calls in the routes directory and
  expanded — a route added without a rule fails the ledger, and a rule
  without a route fails it the other way. A route may answer (2xx, 204 for
  a store, 501 when the composition lacks the feature) or refuse with a
  JSON reason (4xx, and 503 for "no browser is connected"); a 5xx or a
  plain-text body is a failure. `refusesOnly:` names why the seed cannot
  reach a route (sync needs an open stream, ws-ticket needs an OAuth
  registry, a fresh data dir has no installed font) and is checked to stay
  true; `skip:` names why a route is not requested (the SSE stream holds
  the response open, font install reaches the network, RFC 9728 discovery
  answers a bare 404 by design).
- **Its seed composes the app the way production does, and the reason is a
  trap.** `createContainer()` defaults to the IN-MEMORY store, so an app
  built from it has `/api/v1` and the legacy `/api/workspaces` routes
  looking at different worlds — a document created through one is invisible
  to the other, and a lane seeded that way reports every legacy route as
  refusing. The lane builds `serverDeps` from `createStoreLocalModule` over
  the same data dir the module-level document store reads. Each seeded app
  also gets its OWN workspace handle and data dir: the document store is
  module-level and keyed by workspace, and a checkpoint a previous app
  scheduled can land after its test ended — under a reused handle it wrote
  the previous seed's documents into the next seed's fresh database
  (measured: `Document path "board" already exists`, one run in three).
- What the lane found the day it was written, each fixed with an example
  test beside it: a document update whose bytes Loro cannot decode escaped
  the handler as a thrown decode error (now 400 `invalid_body`, checked
  with `decodeImportBlobMeta` before the import, as the workspace-document
  route already did); an export `scale` the schema admitted but that sized
  the render to nothing answered 500 `headless_export_failed` (the schema
  now bounds `scale`/`padding`/`minFontPx`, and the renderer's zero-size
  refusal maps to 400); a missing file answered Hono's plain-text 404 (now
  JSON `not_found`); an empty upload stored a zero-byte file (now 400
  `empty_body`); and creating a document under a handle that passes the id
  validator but cannot be a workspace SEGMENT (`-`) answered 500 "Failed to
  create canvas." — the mint boundary's `WorkspaceSegmentUnusableError`,
  which the handler's own comment promised as a 400, fell through its
  catch-all (now mapped).
