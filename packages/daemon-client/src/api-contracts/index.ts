// Barrel for the `./api-contracts/index` package subpath.
//
// Version skew: the hosted app updates itself behind a service worker and
// the daemon is installed separately, so the two are rarely the same
// version. A schema the browser parses an ANSWER with therefore tolerates a
// field it does not know (Zod strips it), while a schema the daemon parses a
// REQUEST with is `.strict()`. `api-contract-response-tolerance.test.ts` in
// arch-lint holds the line by declaration name (`*RequestSchema`), and
// docs/contributing/architecture/wire-protocol.md carries the reasoning.
//
// What the browser imports these contracts through: apps/web reads most of
// them here, beside the per-file subpaths a caller may name directly. The
// package is private, and mcp-server inlines what it uses into its own dist,
// so this barrel is no npm surface — a name here earns its place by having an
// importer, and one that loses its last importer comes out rather than
// staying "for compatibility". Contracts only the daemon or its CLI read
// (`./runtime`'s ping answer, for one) stay on their own subpath.

// The error contract lives in server-core — `/api/v1` is served from there,
// so a contract filed in this package would sit above half the routes it
// describes — and it comes from the SUBPATH, never the root
// barrel. The difference is 269 KB. A module on apps/web's critical path
// taking `apiErrorReason` from '@kamiazya/whiteboard-server-core' put that
// package's whole graph — hono, loro-crdt, canvas-render, search — in the
// entry chunk: measured 421.4 KB gzip against a 152 KB budget. Nothing
// earlier catches it, because no boundary test can see what a re-export
// DRAGS; only `smoke:bundle-size` can, and only after a build.
// `./api-errors` imports zod and nothing else.
//
// `apiErrorBodySchema` is NOT re-exported: it is what a daemon EMITS, strict
// by design, and a browser reads a refusal through `apiErrorReason`, which
// tolerates a field a newer daemon added.
export { apiErrorReason } from '@kamiazya/whiteboard-server-core/api-errors'
export * from './daemon-urls.js'
export * from './document.js'
export * from './document-url.js'
export * from './fonts.js'
export { promoteWorkspaceResponseSchema } from './promotion.js'
// The six /api/v1 answers, derived from the tool outputs the routes serve and
// tolerant of a newer daemon's added fields (see v1-answers.ts).
export * from './v1-answers.js'
// The bodies the two /api/v1 writes send, derived from the inputs the routes parse.
export type {
  CreateDocumentV1Request,
  LinkifyMentionsV1Request,
  SetTagLibraryV1Request,
} from './v1-requests.js'
