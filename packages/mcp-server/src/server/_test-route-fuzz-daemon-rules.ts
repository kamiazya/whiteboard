// What each daemon route may do: the local-daemon lane's rules, keyed by
// `METHOD pattern` as the app registers it. Shared with the server-mode lane,
// which reads the keys to tell the routes only server mode mounts from the
// ones both compositions serve.
import {
  compactWorkspaceResultSchema,
  createWorkspaceRequestSchema,
  deleteDocumentResponseSchema,
  duplicateDocumentResponseSchema,
  listDocumentsResponseSchema,
  listTrashResponseSchema,
  listVersionsResponseSchema,
  listWorkspacesResponseSchema,
  pruneSandwichedVersionsResponseSchema,
  purgeResultSchema,
  purgeTrashEntryResponseSchema,
  renameDocumentPathRequestSchema,
  renameDocumentPathResponseSchema,
  renameWorkspaceRequestSchema,
  restoreTrashResponseSchema,
  restoreVersionRequestSchema,
  restoreVersionResponseSchema,
  saveVersionRequestSchema,
  saveVersionResponseSchema,
  setNameRequestSchema,
  setPinnedRequestSchema,
  storageReportPayloadSchema,
  updateDocumentResponseSchema,
  versionDocumentResponseSchema,
  workspaceNamesSchema,
  workspaceSummarySchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { listFontsResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/fonts'
import { promoteWorkspaceRequestSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/promotion'
import {
  daemonPingResponseSchema,
  runtimeStatusResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import {
  syncClientMessageRequestSchema,
  syncSubscribeRequestSchema,
} from '@kamiazya/whiteboard-daemon-client/sync-sse-contract'
import { clientCountResponseSchema } from '../shared/api-contracts/document-runtime.js'
import { exportRequestSchema, exportResponseSchema } from '../shared/api-contracts/export.js'
import { exportSvgRequestSchema } from '../shared/api-contracts/export-svg.js'
import type { Rule } from './_test-route-fuzz-lane.js'

export const RULES: Record<string, Rule> = {
  'GET /api/workspaces': { answers: 'json', response: listWorkspacesResponseSchema },
  'POST /api/workspaces': {
    answers: 'json',
    body: createWorkspaceRequestSchema,
    response: workspaceSummarySchema,
  },
  'PATCH /api/workspaces/:workspaceId': {
    answers: 'json',
    body: renameWorkspaceRequestSchema,
    response: workspaceSummarySchema,
  },
  'GET /api/workspaces/:workspaceId/documents': {
    answers: 'json',
    response: listDocumentsResponseSchema,
  },
  'GET /api/workspaces/:workspaceId/names': { answers: 'json', response: workspaceNamesSchema },
  'PUT /api/workspaces/:workspaceId/name': {
    answers: 'json',
    body: setNameRequestSchema,
    response: workspaceNamesSchema,
  },
  'GET /api/workspaces/:workspaceId/trash': { answers: 'json', response: listTrashResponseSchema },
  'DELETE /api/workspaces/:workspaceId/trash/:documentId': {
    answers: 'json',
    response: purgeTrashEntryResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/trash/:documentId/restore': {
    answers: 'json',
    response: restoreTrashResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/versions/prune-sandwiched': {
    answers: 'json',
    response: pruneSandwichedVersionsResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/documents/optimize-all': {
    answers: 'json',
    response: compactWorkspaceResultSchema,
  },
  'POST /api/workspaces/:workspaceId/files/purge-dangling': {
    answers: 'json',
    response: purgeResultSchema,
  },
  'GET /api/workspaces/:workspaceId/documents/*/versions': {
    answers: 'json',
    response: listVersionsResponseSchema,
  },
  'GET /api/workspaces/:workspaceId/documents/*/versions/:id/document': {
    answers: 'json',
    response: versionDocumentResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/documents/*/versions': {
    answers: 'json',
    body: saveVersionRequestSchema,
    response: saveVersionResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/documents/*/versions/:id/restore': {
    answers: 'json',
    body: restoreVersionRequestSchema,
    response: restoreVersionResponseSchema,
  },
  'PUT /api/workspaces/:workspaceId/documents/*/name': {
    answers: 'json',
    body: setNameRequestSchema,
    response: workspaceNamesSchema,
  },
  'POST /api/workspaces/:workspaceId/documents/*/duplicate': {
    answers: 'json',
    response: duplicateDocumentResponseSchema,
  },
  'PUT /api/workspaces/:workspaceId/documents/*/pin': {
    answers: 'json',
    body: setPinnedRequestSchema,
    response: workspaceNamesSchema,
  },
  'PUT /api/workspaces/:workspaceId/documents/*/path': {
    answers: 'json',
    body: renameDocumentPathRequestSchema,
    response: renameDocumentPathResponseSchema,
  },
  'DELETE /api/workspaces/:workspaceId/documents/*': {
    answers: 'json',
    response: deleteDocumentResponseSchema,
  },
  'GET /api/w/:workspaceId/document/*/snapshot': { answers: 'bytes' },
  'GET /api/w/:workspaceId/document/*/client-count': {
    answers: 'json',
    response: clientCountResponseSchema,
  },
  'POST /api/w/:workspaceId/document/*/update': {
    answers: 'json',
    raw: true,
    response: updateDocumentResponseSchema,
  },
  'POST /api/w/:workspaceId/document/*/export': {
    answers: 'json',
    body: exportRequestSchema,
    runs: 24,
    response: exportResponseSchema,
  },
  'POST /api/w/:workspaceId/document/*/export-svg': {
    answers: 'json',
    body: exportSvgRequestSchema,
    runs: 24,
    response: exportResponseSchema,
  },
  'PUT /api/w/:workspaceId/document/*/file/:fileId': {
    answers: 'none',
    raw: true,
    contentType: 'image/png',
  },
  'GET /api/w/:workspaceId/document/*/file/:fileId': { answers: 'bytes' },
  'GET /api/w/:workspaceId/workspace-document/snapshot': { answers: 'bytes' },
  'POST /api/w/:workspaceId/workspace-document/update': {
    answers: 'json',
    raw: true,
    response: updateDocumentResponseSchema,
  },
  'POST /api/w/:workspaceId/workspace-document/promote': {
    refusesOnly:
      'a schema-drawn snapshot is random base64url and never a Loro record; the merge, the rows and the attestation verdicts are routes/document/workspace-promote.test.ts',
    body: promoteWorkspaceRequestSchema,
  },
  'GET /api/sync/stream': { skip: 'holds the response open until the client goes away' },
  'POST /api/sync/subscribe': {
    refusesOnly: 'needs the stream id of an open /api/sync/stream, which this lane never opens',
    body: syncSubscribeRequestSchema,
  },
  'POST /api/sync/message': {
    refusesOnly: 'needs the stream id of an open /api/sync/stream, which this lane never opens',
    body: syncClientMessageRequestSchema,
  },
  'GET /api/runtime/ping': { answers: 'json', response: daemonPingResponseSchema },
  'GET /api/runtime/status': { answers: 'json', response: runtimeStatusResponseSchema },
  'GET /api/runtime/storage': { answers: 'json', response: storageReportPayloadSchema },
  'GET /api/fonts': { answers: 'json', response: listFontsResponseSchema },
  'GET /api/fonts/:id/file': { refusesOnly: 'a fresh data dir has no installed font' },
  'POST /api/fonts/:id/install': { skip: 'downloads the font from the network' },
}
