import { z } from 'zod'

/**
 * The image types the daemon's file route stores, declared once for both
 * sides of the wire: the route answers 415 for anything else, and the editor
 * refuses the rest at pick, drop and paste instead of sending what the daemon
 * is certain to refuse. A second list on either side is how the editor came to
 * offer every `image/*` while the route accepted five.
 */
export const UPLOADABLE_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const

export const uploadableImageTypeSchema = z.enum(UPLOADABLE_IMAGE_TYPES)

export type UploadableImageType = z.infer<typeof uploadableImageTypeSchema>

export function isUploadableImageType(type: string): type is UploadableImageType {
  return uploadableImageTypeSchema.safeParse(type).success
}

/**
 * Per-file ceiling the route answers 413 above. It bounds what a single
 * upload may hold in memory, so a client checking its own file against it is
 * asking the same question the daemon will.
 */
export const MAX_FILE_UPLOAD_BYTES = 16 * 1024 * 1024
