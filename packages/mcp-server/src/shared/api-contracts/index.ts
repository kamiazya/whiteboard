// Public barrel for the `./api-contracts` package subpath.
//
// Deliberately narrow: only the schemas below are re-exported here.
// canvas-runtime.ts, daemon-doctor.ts, export.ts, libraries.ts, and the
// rest of runtime.ts stay off the published npm surface — widening this
// barrel widens semver liability for a public package, so any addition
// here must be an intentional decision, not incidental scope creep.
// daemonPingResponseSchema is promoted here so apps/web can consume the
// ping contract from its single definition instead of maintaining a
// hand-written mirror.

// The OpenCanvas /api/v1 list contract, re-exported from server-core so
// apps/web keeps consuming every daemon HTTP contract through this one
// barrel instead of importing a shared-layer package it is not allowed to
// depend on directly (see .claude/rules/architecture-map.md).
export {
  canvasExportOkfOutputSchema as canvasOkfV1ResponseSchema,
  listCanvasesOutputSchema as listCanvasesV1ResponseSchema,
} from '@kamiazya/whiteboard-server-core'
export * from './branches.js'
export * from './canvas.js'
export type { DaemonPingResponse } from './runtime.js'
export { daemonPingResponseSchema } from './runtime.js'

import type {
  canvasExportOkfOutputSchema as _canvasOkfV1ResponseSchema,
  listCanvasesOutputSchema as _listCanvasesV1ResponseSchema,
} from '@kamiazya/whiteboard-server-core'
import type { z as _z } from 'zod'
export type CanvasOkfV1Response = _z.infer<typeof _canvasOkfV1ResponseSchema>
export type ListCanvasesV1Response = _z.infer<typeof _listCanvasesV1ResponseSchema>
