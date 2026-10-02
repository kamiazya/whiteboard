/**
 * What the editor lets a person put on a canvas as an image, and what it says
 * when it refuses one.
 *
 * The set and the ceiling are the daemon file route's own contract
 * (`api-contracts/files`), applied to every keeper: a browser-kept document
 * could store more, but a workspace can only be promoted to a daemon with what
 * the daemon will accept, so offering a type the daemon refuses is a refusal
 * deferred to the day the move fails.
 */
import {
  isUploadableImageType,
  MAX_FILE_UPLOAD_BYTES,
  UPLOADABLE_IMAGE_TYPES,
  type UploadableImageType,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/files'

/** The picker's `accept` value: the uploadable types, never `image/*`. */
export const IMAGE_FILE_ACCEPT = UPLOADABLE_IMAGE_TYPES.join(',')

// Keyed by the contract's set, so a type added there without a label fails to compile.
const TYPE_LABELS: Record<UploadableImageType, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/svg+xml': 'SVG',
}

const SUPPORTED_TYPES = UPLOADABLE_IMAGE_TYPES.map((type) => TYPE_LABELS[type]).join(', ')
const LIMIT = `${MAX_FILE_UPLOAD_BYTES / (1024 * 1024)} MiB`

/** Why this file cannot be uploaded, or null when it can. */
export function imageRefusal(file: Pick<File, 'type' | 'size'>): string | null {
  if (!isUploadableImageType(file.type)) {
    const named = file.type === '' ? 'This file type' : file.type
    return `${named} is not supported. Images can be ${SUPPORTED_TYPES}.`
  }
  if (file.size > MAX_FILE_UPLOAD_BYTES) return `That image is over the ${LIMIT} limit.`
  return null
}

/**
 * The file a drop or paste should act on: a supported image if there is one,
 * else the first image of any type, so an unsupported one is refused aloud
 * rather than ignored. A non-image is no business of the image path at all.
 */
export function firstImageFile(files: Iterable<File>): File | undefined {
  const images = [...files].filter((f) => f.type.startsWith('image/'))
  return images.find((f) => isUploadableImageType(f.type)) ?? images[0]
}

/** What to tell a person whose upload the daemon answered with `status`. */
export function uploadRefusalReason(status: number): string {
  if (status === 413) return `That image is over the daemon's ${LIMIT} limit.`
  if (status === 415) return `The daemon only stores ${SUPPORTED_TYPES} images.`
  return `The daemon could not store that image (HTTP ${status}).`
}
