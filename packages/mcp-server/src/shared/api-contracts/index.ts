// Public barrel for the `./api-contracts` package subpath.
//
// Deliberately narrow: only the schemas below are re-exported here.
// document-runtime.ts, daemon-doctor.ts, export.ts, libraries.ts, and the
// rest of runtime.ts stay off the published npm surface — widening this
// barrel widens semver liability for a public package, so any addition
// here must be an intentional decision, not incidental scope creep.
// daemonPingResponseSchema, runtimeVerifyResponseSchema, and
// listGrantsResponseSchema are promoted so apps/web consumes each contract
// from its single definition instead of a hand-written mirror that can
// silently drift from the server's shape.

// The /api/v1 document list contract, re-exported from server-core so
// apps/web keeps consuming every daemon HTTP contract through this one
// barrel instead of importing a shared-layer package it is not allowed to
// depend on directly (see .claude/rules/architecture-map.md).
export {
  exportOkfOutputSchema as documentOkfV1ResponseSchema,
  wbDocumentListOutputSchema as listDocumentsV1ResponseSchema,
} from '@kamiazya/whiteboard-server-core'
export * from './branches.js'
export * from './document.js'
export * from './document-url.js'
export * from './errors.js'
export * from './fonts.js'
export type { ListGrantsResponse, PairingTokenResponse } from './pairing.js'
export {
  listGrantsResponseSchema,
  pairingTokenNonceSchema,
  pairingTokenRequestSchema,
  pairingTokenResponseSchema,
} from './pairing.js'
export type { DaemonPingResponse, RuntimeVerifyResponse } from './runtime.js'
export { daemonPingResponseSchema, runtimeVerifyResponseSchema } from './runtime.js'

import type {
  exportOkfOutputSchema as _canvasOkfV1ResponseSchema,
  wbDocumentListOutputSchema as _listDocumentsV1ResponseSchema,
} from '@kamiazya/whiteboard-server-core'
import type { z as _z } from 'zod'
export type DocumentOkfV1Response = _z.infer<typeof _canvasOkfV1ResponseSchema>
export type ListDocumentsV1Response = _z.infer<typeof _listDocumentsV1ResponseSchema>
