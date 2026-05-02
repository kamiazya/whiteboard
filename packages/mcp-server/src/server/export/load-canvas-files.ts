// Read all binary files attached to a workspace and shape them as the
// `files` map that @excalidraw/utils.exportToSvg expects.
//
// Files are stored under DATA_DIR/{workspaceId}/files/{fileId}{ext}. The
// browser-facing route in routes/files.ts already reads from this same layout
// and serves a 200 with Content-Type derived from the extension.

import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { DATA_DIR } from '../config.js'
import { isMissingFileError } from '../store/corrupt-stored-data.js'

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

export interface CanvasFile {
  mimeType: string
  id: string
  dataURL: string
  created: number
}

export async function loadCanvasFiles(
  workspaceId: string,
): Promise<Record<string, CanvasFile>> {
  const dir = join(DATA_DIR, workspaceId, 'files')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if (isMissingFileError(err)) return {}
    throw err
  }
  const out: Record<string, CanvasFile> = {}
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase()
    const mime = EXT_TO_MIME[ext]
    if (!mime) continue
    const fileId = basename(entry, ext)
    const buf = await readFile(join(dir, entry))
    out[fileId] = {
      mimeType: mime,
      id: fileId,
      dataURL: `data:${mime};base64,${buf.toString('base64')}`,
      created: Date.now(),
    }
  }
  return out
}
