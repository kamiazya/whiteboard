import { z } from 'zod'

/**
 * Content-addressed reference to a blob. BlobStore is global/content-addressed
 * by design, not workspace-scoped — the same bytes anywhere in the system
 * hash to the same ref, so storage can be deduplicated across workspaces
 * and canvases.
 */
export const blobRefSchema = z
  .object({
    algorithm: z.literal('sha-256'),
    digestHex: z.string().regex(/^[0-9a-f]{64}$/, 'digestHex must be 64 lowercase hex characters'),
  })
  .strict()

export type BlobRef = z.infer<typeof blobRefSchema>

export const blobPutInputSchema = z
  .object({
    bytes: z.instanceof(Uint8Array),
    contentType: z.string().min(1).optional(),
  })
  .strict()
export type BlobPutInput = z.infer<typeof blobPutInputSchema>

export const blobPutResultSchema = z.object({ ref: blobRefSchema }).strict()
export type BlobPutResult = z.infer<typeof blobPutResultSchema>

export const blobGetInputSchema = z.object({ ref: blobRefSchema }).strict()
export type BlobGetInput = z.infer<typeof blobGetInputSchema>

export const blobGetResultSchema = z
  .object({
    bytes: z.instanceof(Uint8Array),
    contentType: z.string().min(1).optional(),
  })
  .strict()
  .nullable()
export type BlobGetResult = z.infer<typeof blobGetResultSchema>

export const blobHasInputSchema = z.object({ ref: blobRefSchema }).strict()
export type BlobHasInput = z.infer<typeof blobHasInputSchema>

export const blobHasResultSchema = z.object({ exists: z.boolean() }).strict()
export type BlobHasResult = z.infer<typeof blobHasResultSchema>

export const blobDeleteInputSchema = z.object({ ref: blobRefSchema }).strict()
export type BlobDeleteInput = z.infer<typeof blobDeleteInputSchema>

/**
 * Content-addressed blob storage (attachments, exported assets, etc.).
 * Deliberately global rather than workspace-scoped: two workspaces
 * referencing identical bytes should share one stored copy.
 */
export interface BlobStore {
  put(input: BlobPutInput): Promise<BlobPutResult>
  get(input: BlobGetInput): Promise<BlobGetResult>
  has(input: BlobHasInput): Promise<BlobHasResult>
  delete(input: BlobDeleteInput): Promise<void>
}
