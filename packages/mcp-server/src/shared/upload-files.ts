import { apiFetch } from './api-client.js'
import type { BinaryFileDataLike } from './canvas-backend-contract.js'

/**
 * Upload binary payloads for new fileIds with PUT /file/:fileId.
 *
 * Uses Promise.all, so any single failure rejects the whole upload step.
 * Callers must skip commitToLoro() when this rejects so elements never
 * reference files that failed to upload.
 */
export async function uploadFiles(
  newEntries: [string, BinaryFileDataLike][],
  workspaceId: string,
  slug: string,
  onSuccess: (fileId: string) => void,
): Promise<void> {
  await Promise.all(
    newEntries.map(async ([fileId, fd]) => {
      const [, base64] = fd.dataURL.split(',')
      // A malformed dataURL (no comma) would reach atob(undefined) and throw a
      // cryptic DOMException; fail with an identifiable error instead.
      if (!base64) {
        throw new Error(`file ${fileId}: malformed dataURL (no base64 payload)`)
      }
      const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const res = await apiFetch(
        `/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/file/${encodeURIComponent(fileId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': fd.mimeType },
          body: binary,
        },
      )
      if (!res.ok) {
        throw new Error(`PUT /file/${fileId} failed: ${res.status}`)
      }
      onSuccess(fileId)
    }),
  )
}
