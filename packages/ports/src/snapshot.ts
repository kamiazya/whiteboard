import { z } from 'zod'

/**
 * One chunk of a chunked snapshot upload/download. `bytes` is refined to be
 * non-empty so a zero-byte chunk can never validly appear in a populated
 * chunk list — this is what keeps "empty snapshot" (chunkCount 0, chunks
 * []) unambiguous from "invalid empty chunk" (a chunk entry with no bytes).
 */
export const snapshotChunkSchema = z
  .object({
    index: z.number().int().min(0),
    of: z.number().int().min(1),
    bytes: z.instanceof(Uint8Array),
  })
  .strict()
  .refine((chunk) => chunk.index < chunk.of, {
    message: 'index must be less than of',
    path: ['index'],
  })
  .refine((chunk) => chunk.bytes.byteLength > 0, {
    message: 'chunk bytes must be non-empty',
    path: ['bytes'],
  })

export type SnapshotChunk = z.infer<typeof snapshotChunkSchema>

/**
 * Describes how a snapshot's bytes were chunked. Deliberately does NOT
 * carry a `docRef` — the manifest only describes the chunking, and which
 * document it belongs to is always supplied separately as a store-operation
 * argument (see DocumentStore.saveSnapshot). `maxChunkBytes` is the
 * caller-supplied cap that produced this manifest; ports does not
 * hardcode any implementation's specific limit (e.g. Cloudflare Durable
 * Objects' ~2MB message cap) here. What ports DOES hold is the value the
 * planes that already exist agreed on, so their writers cannot drift apart
 * — see `DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES` below.
 */
export const snapshotManifestSchema = z
  .object({
    chunkCount: z.number().int().min(0),
    totalBytes: z.number().int().min(0),
    maxChunkBytes: z.number().int().positive(),
  })
  .strict()
  .refine((manifest) => (manifest.chunkCount === 0) === (manifest.totalBytes === 0), {
    message: 'chunkCount must be 0 if and only if totalBytes is 0',
    path: ['chunkCount'],
  })

export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>

/**
 * The chunk size every writer of the EXISTING snapshot planes shares.
 *
 * This is not the implementation limit the comment above refuses to
 * hardcode, and the difference decides where a number belongs.
 * `chunkSnapshot` still takes `maxChunkBytes` as a required parameter, and
 * `snapshotManifestSchema` persists the value each document was actually
 * written with — so a backend whose transport has its own cap, the
 * Cloudflare Durable Objects one the comment names, declares and passes its
 * own and its documents record it. What this constant fixes is the
 * AGREEMENT among the writers of the planes that already exist: the daemon's
 * libSQL tables and the browser's IndexedDB stores.
 *
 * That agreement is load-bearing because a snapshot chunked by one path has
 * to reassemble identically when read by another, and a writer using a
 * different value produces rows `reassembleSnapshot` refuses only later,
 * from some other path. The value itself is arbitrary and generous: a
 * single-chunk snapshot is the normal case, neither IndexedDB nor libSQL has
 * a message cap to respect, and the chunking exists to satisfy the contract
 * rather than to work around a limit.
 *
 * It lived as eight separate declarations under four names across five
 * packages, with the coupling stated only in prose.
 * `tools/arch-lint/src/chunk-size-one-place.test.ts` is why there is one
 * now, and it classifies the four hardcoded values that remain.
 */
export const DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000
