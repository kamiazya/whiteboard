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
 * caller-supplied cap that produced this manifest; canvas-ports does not
 * hardcode any implementation's specific limit (e.g. Cloudflare Durable
 * Objects' ~2MB message cap) here.
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
