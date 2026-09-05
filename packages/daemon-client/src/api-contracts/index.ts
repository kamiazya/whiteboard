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
  backlinksOutputSchema as documentBacklinksResponseSchema,
  documentSearchOutputSchema as documentSearchResponseSchema,
  documentTagsOutputSchema as workspaceDocumentTagsResponseSchema,
  exportOkfOutputSchema as documentOkfV1ResponseSchema,
  linkifyMentionsOutputSchema as linkifyMentionsResponseSchema,
  wbDocumentListOutputSchema as listDocumentsV1ResponseSchema,
} from '@kamiazya/whiteboard-server-core'
export * from './branches.js'
export * from './document.js'
export * from './document-url.js'
export * from './errors.js'
export * from './fonts.js'
export type { CreateGrantResponse, ListGrantsResponse, PairingTokenResponse } from './pairing.js'
export {
  createGrantRequestSchema,
  createGrantResponseSchema,
  listGrantsResponseSchema,
  pairingTokenNonceSchema,
  pairingTokenRequestSchema,
  pairingTokenResponseSchema,
} from './pairing.js'
// The daemon-pairing-link fragment contract: shared by the wb_pairing_link_create
// MCP tool (mints the link) and apps/web's fragment parser (reads it back), so
// the two cannot silently disagree on the payload shape.
export type { DaemonConnectionPayload } from './pairing-link.js'
export {
  DAEMON_CONNECTION_FRAGMENT_KEY,
  daemonConnectionPayloadSchema,
  decodeBase64UrlText,
  encodeBase64UrlText,
  MIN_BOOTSTRAP_TOKEN_LENGTH,
} from './pairing-link.js'
export type { DaemonPingResponse, RuntimeVerifyResponse } from './runtime.js'
export { daemonPingResponseSchema, runtimeVerifyResponseSchema } from './runtime.js'

import type {
  exportOkfOutputSchema as _canvasOkfV1ResponseSchema,
  backlinksOutputSchema as _documentBacklinksResponseSchema,
  documentSearchOutputSchema as _documentSearchResponseSchema,
  linkifyMentionsOutputSchema as _linkifyMentionsResponseSchema,
  wbDocumentListOutputSchema as _listDocumentsV1ResponseSchema,
  documentTagsOutputSchema as _workspaceDocumentTagsResponseSchema,
} from '@kamiazya/whiteboard-server-core'
import type { z as _z } from 'zod'
export type DocumentBacklinksResponse = _z.infer<typeof _documentBacklinksResponseSchema>
export type WorkspaceDocumentTagsResponse = _z.infer<typeof _workspaceDocumentTagsResponseSchema>
export type LinkifyMentionsResponse = _z.infer<typeof _linkifyMentionsResponseSchema>
export type DocumentOkfV1Response = _z.infer<typeof _canvasOkfV1ResponseSchema>
export type ListDocumentsV1Response = _z.infer<typeof _listDocumentsV1ResponseSchema>
export type DocumentSearchResponse = _z.infer<typeof _documentSearchResponseSchema>
