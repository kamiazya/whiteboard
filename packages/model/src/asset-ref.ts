/**
 * The one convention distinguishing a file node that points at a stored image
 * from one that points at another canvas.
 *
 * Shared by every backend and every reader deliberately: a canvas authored in
 * browser-local mode, one authored against the daemon, and the daemon's own
 * file-GC reference walk must all mean the same thing by the same `file`
 * value, or moving content between them (or garbage-collecting it) would
 * silently reinterpret every image node as a canvas reference.
 *
 * The colon is what makes this unambiguous — a daemon path and a browser-local
 * canvas id both match /^[a-zA-Z0-9_-]+$/, so neither can ever collide with a
 * prefixed reference.
 */
const IMAGE_REF_PREFIX = 'asset:'

export function isImageRef(file: string): boolean {
  return file.startsWith(IMAGE_REF_PREFIX)
}

/** Mints a reference for a newly stored image. */
export function newImageRef(id: string): string {
  return `${IMAGE_REF_PREFIX}${id}`
}

/**
 * The backend-side id inside an image reference. The daemon's file route
 * validates this against /^[a-zA-Z0-9_-]+$/, so the prefix must be stripped
 * before it travels in a path.
 */
export function imageRefId(file: string): string {
  return file.slice(IMAGE_REF_PREFIX.length)
}
