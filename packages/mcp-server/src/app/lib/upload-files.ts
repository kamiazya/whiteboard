import type { BinaryFileData } from '@excalidraw/excalidraw/types'
import { apiFetch } from './api-client.js'

/**
 * Upload binary payloads for new fileIds with PUT /file/:fileId.
 *
 * Uses Promise.all, so any single failure rejects the whole upload step.
 * Callers must skip commitToLoro() when this rejects so elements never
 * reference files that failed to upload.
 */
export async function uploadFiles(
  newEntries: [string, BinaryFileData][],
  sessionId: string,
  slug: string,
  onSuccess: (fileId: string) => void,
): Promise<void> {
  await Promise.all(
    newEntries.map(async ([fileId, fd]) => {
      const [, base64] = fd.dataURL.split(',')
      if (base64 === undefined) {
        throw new Error(`dataURL for ${fileId} is missing a base64 payload`)
      }
      const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const res = await apiFetch(`/api/canvas/${sessionId}/${encodeURIComponent(slug)}/file/${fileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': fd.mimeType },
        body: binary,
      })
      if (!res.ok) {
        throw new Error(`PUT /file/${fileId} failed: ${res.status}`)
      }
      onSuccess(fileId)
    }),
  )
}
