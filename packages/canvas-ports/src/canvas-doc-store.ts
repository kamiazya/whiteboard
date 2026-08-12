import { z } from 'zod'
import { deltaBatchSchema } from './delta.js'
import { docRefSchema } from './doc-ref.js'
import { frontierSchema } from './frontier.js'
import { snapshotChunkSchema, snapshotManifestSchema } from './snapshot.js'

export const loadSnapshotInputSchema = z.object({ docRef: docRefSchema }).strict()
export type LoadSnapshotInput = z.infer<typeof loadSnapshotInputSchema>

/**
 * A schema-level cross-check between `manifest` and `chunks`: the array
 * length must match `manifest.chunkCount` and the chunks' combined byte
 * length must match `manifest.totalBytes`. Without this, a boundary-valid
 * but internally inconsistent pair (e.g. an empty manifest paired with a
 * non-empty chunk) parses successfully and only surfaces later, when
 * `reassembleSnapshot`'s `chunkCount === 0` short-circuit silently discards
 * the supplied chunk. This does not duplicate `reassembleSnapshot`'s deeper
 * per-chunk checks (index range, duplicates, ordering, `of` agreement) —
 * those remain the single source of truth for reassembly correctness.
 */
function manifestChunksConsistent(payload: {
  manifest: z.infer<typeof snapshotManifestSchema>
  chunks: z.infer<typeof snapshotChunkSchema>[]
}): boolean {
  if (payload.chunks.length !== payload.manifest.chunkCount) {
    return false
  }
  const aggregateLength = payload.chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0)
  return aggregateLength === payload.manifest.totalBytes
}

const manifestChunksConsistencyIssue = {
  message: 'chunks must match manifest.chunkCount and sum to manifest.totalBytes',
  path: ['chunks'],
}

export const loadSnapshotResultSchema = z
  .object({
    manifest: snapshotManifestSchema,
    chunks: z.array(snapshotChunkSchema),
    frontier: frontierSchema,
  })
  .strict()
  .refine(manifestChunksConsistent, manifestChunksConsistencyIssue)
  .nullable()
export type LoadSnapshotResult = z.infer<typeof loadSnapshotResultSchema>

export const saveSnapshotInputSchema = z
  .object({
    docRef: docRefSchema,
    manifest: snapshotManifestSchema,
    chunks: z.array(snapshotChunkSchema),
    frontier: frontierSchema,
  })
  .strict()
  .refine(manifestChunksConsistent, manifestChunksConsistencyIssue)
export type SaveSnapshotInput = z.infer<typeof saveSnapshotInputSchema>

export const appendDeltasInputSchema = z
  .object({ docRef: docRefSchema, deltaBatch: deltaBatchSchema })
  .strict()
export type AppendDeltasInput = z.infer<typeof appendDeltasInputSchema>

export const appendDeltasResultSchema = z.object({ frontier: frontierSchema }).strict()
export type AppendDeltasResult = z.infer<typeof appendDeltasResultSchema>

export const loadDeltasInputSchema = z
  .object({ docRef: docRefSchema, sinceFrontier: frontierSchema })
  .strict()
export type LoadDeltasInput = z.infer<typeof loadDeltasInputSchema>

export const loadDeltasResultSchema = z
  .object({ updates: z.array(z.instanceof(Uint8Array)), frontier: frontierSchema })
  .strict()
export type LoadDeltasResult = z.infer<typeof loadDeltasResultSchema>

export const readFrontierInputSchema = z.object({ docRef: docRefSchema }).strict()
export type ReadFrontierInput = z.infer<typeof readFrontierInputSchema>

export const readFrontierResultSchema = z.object({ frontier: frontierSchema }).strict().nullable()
export type ReadFrontierResult = z.infer<typeof readFrontierResultSchema>

/**
 * Persistence for a single Loro-backed document (a canvas or the
 * workspace-tree). `docRef` carries the scope for every method; there is
 * no separate workspace-scoping field because the document itself is the
 * unit of storage.
 */
export interface CanvasDocStore {
  loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult>
  saveSnapshot(input: SaveSnapshotInput): Promise<void>
  appendDeltas(input: AppendDeltasInput): Promise<AppendDeltasResult>
  loadDeltas(input: LoadDeltasInput): Promise<LoadDeltasResult>
  readFrontier(input: ReadFrontierInput): Promise<ReadFrontierResult>
}
