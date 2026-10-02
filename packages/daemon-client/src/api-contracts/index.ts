// Public barrel for the `./api-contracts` package subpath.
//
// Version skew: the hosted app updates itself behind a service worker and
// the daemon is installed separately, so the two are rarely the same
// version. A schema the browser parses an ANSWER with therefore tolerates a
// field it does not know (Zod strips it), while a schema the daemon parses a
// REQUEST with is `.strict()`. `api-contract-response-tolerance.test.ts` in
// arch-lint holds the line by declaration name (`*RequestSchema`), and
// docs/contributing/architecture/wire-protocol.md carries the reasoning.
//
// Deliberately narrow: only the schemas below are re-exported here.
// mcp-server's shared/api-contracts (document-runtime.ts, daemon-doctor.ts,
// export.ts) and the rest of runtime.ts stay off the published npm surface — widening this
// barrel widens semver liability for a public package, so any addition
// here must be an intentional decision, not incidental scope creep.
// daemonPingResponseSchema and listGrantsResponseSchema are promoted so apps/web consumes each contract
// from its single definition instead of a hand-written mirror that can
// silently drift from the server's shape.

// The error contract moved DOWN to server-core to join them — `/api/v1` is
// served from there, so a contract filed in this package was above half the
// routes it describes — and it comes from the SUBPATH, never the root
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
export type { ApiErrorBody } from '@kamiazya/whiteboard-server-core/api-errors'
export {
  apiErrorCodeSchema,
  apiErrorReason,
  errorBody,
  invalidRequestBody,
} from '@kamiazya/whiteboard-server-core/api-errors'
export * from './daemon-urls.js'
export * from './document.js'
export * from './document-url.js'
export * from './fonts.js'
export type { Attestation, PromoteWorkspaceRequest, PromoteWorkspaceResponse } from './promotion.js'
export {
  base64urlSchema,
  promoteWorkspaceRequestSchema,
  promoteWorkspaceResponseSchema,
  promotionChallengeInput,
} from './promotion.js'
export type { DaemonPingResponse } from './runtime.js'
export { daemonPingResponseSchema } from './runtime.js'
// The six /api/v1 answers, derived from the tool outputs the routes serve and
// tolerant of a newer daemon's added fields (see v1-answers.ts).
export * from './v1-answers.js'
