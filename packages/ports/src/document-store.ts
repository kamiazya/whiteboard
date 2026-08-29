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

/**
 * A fencing token for the stored snapshot, advanced by every write that
 * replaces it (ADR-0020).
 *
 * Read alongside the manifest and presented back on a fold, it is what makes
 * the fold conditional. Opaque on purpose beyond "it changes": a caller
 * compares it for equality and never does arithmetic on it, so a store is
 * free to implement it as a counter, a row version, or a clock.
 */
export const snapshotGenerationSchema = z.number().int().min(0)
export type SnapshotGeneration = z.infer<typeof snapshotGenerationSchema>

/**
 * A snapshot that already contains the first `supersededDeltaCount` entries of
 * the document's delta log.
 *
 * The COUNT is what makes the operation safe, and leaving it out is not a
 * simplification — it is a lost update. A caller folds a log it has read; by
 * the time the store writes, another append may have arrived. "Clear the log"
 * would take that one too, and it cannot be in the snapshot, because it did
 * not exist when the caller folded. Naming how many were superseded lets the
 * store drop exactly those and keep the rest.
 */
export const saveCompactedSnapshotInputSchema = saveSnapshotInputSchema.safeExtend({
  supersededDeltaCount: z.number().int().min(0),
  /**
   * The generation this fold was computed against, or `null` to mean "there
   * was no snapshot" — the create half of the same conditional write, so
   * racing to mint a document needs no second operation.
   *
   * Required rather than optional. An optional fence is one a caller forgets,
   * and the shape it protects against — a second folder replacing the
   * snapshot this one is about to write — is invisible in a single-process
   * test run.
   */
  expectedGeneration: snapshotGenerationSchema.nullable(),
})
export type SaveCompactedSnapshotInput = z.infer<typeof saveCompactedSnapshotInputSchema>

/**
 * A refusal is an OUTCOME, not an error: losing the race is expected under
 * concurrency and the caller's answer is to append its update to the log
 * instead. Throwing would push a routine control-flow branch through a catch,
 * where it reads as a failure worth logging.
 */
export const saveCompactedSnapshotResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), generation: snapshotGenerationSchema }).strict(),
  z
    .object({ ok: z.literal(false), currentGeneration: snapshotGenerationSchema.nullable() })
    .strict(),
])
export type SaveCompactedSnapshotResult = z.infer<typeof saveCompactedSnapshotResultSchema>

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

export const readSnapshotManifestInputSchema = z.object({ docRef: docRefSchema }).strict()
export type ReadSnapshotManifestInput = z.infer<typeof readSnapshotManifestInputSchema>

export const readSnapshotManifestResultSchema = z
  .object({ manifest: snapshotManifestSchema, generation: snapshotGenerationSchema })
  .strict()
  .nullable()
export type ReadSnapshotManifestResult = z.infer<typeof readSnapshotManifestResultSchema>

export const deleteDocInputSchema = z.object({ docRef: docRefSchema }).strict()
export type DeleteDocInput = z.infer<typeof deleteDocInputSchema>

/**
 * Persistence for a single Loro-backed document (a canvas or the
 * workspace-tree). `docRef` carries the scope for every method; there is
 * no separate workspace-scoping field because the document itself is the
 * unit of storage.
 */
export interface DocumentStore {
  /**
   * `null` means the document has no snapshot. It does NOT mean the store
   * could not read one: a record that is present but unreadable throws
   * `StoredDocumentUnreadableError`, so a caller can tell "you have no such
   * document" from "your build cannot read this one" — which are opposite
   * things to tell a user about their own data.
   */
  loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult>
  /**
   * The stored snapshot's manifest, WITHOUT its bytes.
   *
   * Exists because "is there a base to append to?" is a different question
   * from "give me the base", and answering the first with the second is what
   * makes an append cost as much as the document is big. Every caller that
   * folds a delta log has to ask both, but only when it folds — and folding
   * is rare by design.
   *
   * Answers `null` in exactly the states `loadSnapshot` answers `null`, and
   * throws `StoredDocumentUnreadableError` in exactly the states it throws.
   * A caller uses this to decide whether to call that one, so the two
   * disagreeing about whether a document exists would be worse than not
   * having this at all.
   *
   * An implementation is expected to answer it without reading the chunks.
   * That cannot be checked from the contract — a caller sees answers, not the
   * work behind them — so it is stated here and belongs in each store's own
   * test.
   */
  readSnapshotManifest(input: ReadSnapshotManifestInput): Promise<ReadSnapshotManifestResult>
  saveSnapshot(input: SaveSnapshotInput): Promise<void>
  /**
   * Save a snapshot that already contains everything in the delta log, and
   * drop the log.
   *
   * Separate from `saveSnapshot` because the two differ in exactly one
   * promise and it is not one a flag should carry: an ordinary save leaves
   * the log alone, because a snapshot and the updates after it are both
   * live. Folding is the caller's — it needs the CRDT runtime, which a store
   * does not have — so this operation is "I folded the first N; those are
   * redundant now", and it is ONE operation because doing it as
   * save-then-clear gives a window where a concurrent append is dropped.
   *
   * Drops exactly `supersededDeltaCount` entries, oldest first, and keeps
   * everything after them. An append that arrives while this is in flight
   * therefore survives — it is not in the snapshot and it is not superseded.
   *
   * Without this a log has no way to stop growing while the document lives:
   * `deleteDoc` is the only other thing that clears one.
   */
  saveCompactedSnapshot(input: SaveCompactedSnapshotInput): Promise<SaveCompactedSnapshotResult>
  appendDeltas(input: AppendDeltasInput): Promise<AppendDeltasResult>
  loadDeltas(input: LoadDeltasInput): Promise<LoadDeltasResult>
  readFrontier(input: ReadFrontierInput): Promise<ReadFrontierResult>
  /**
   * Remove everything stored for the document: snapshot, chunks, frontier
   * and deltas. Deleting an absent document succeeds — the caller wants the
   * document gone, and reporting that it already was gone would only make
   * every call site write the same catch.
   */
  deleteDoc(input: DeleteDocInput): Promise<void>
}
