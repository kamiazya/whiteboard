// Read the binary files referenced by an exported canvas and shape them
// as the `files` map that @excalidraw/utils.exportToSvg expects.
//
// Files are stored under DATA_DIR/{workspaceId}/files/{fileId}{ext}. The
// browser-facing route in routes/files.ts already reads from this same
// layout and serves a 200 with Content-Type derived from the extension.
//
// The set of referenced fileIds is supplied by the caller (computed from
// the canvas elements). Walking the whole directory and base64-encoding
// every attachment in the workspace was the previous behaviour — that
// scaled the export payload with the entire workspace, not the canvas
// being exported, AND raced file GC between readdir() and readFile()
// for unrelated entries.

import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { DATA_DIR } from '../config.js'
import { isMissingFileError } from '../store/corrupt-stored-data.js'

// `fileId` rides through Excalidraw element data, which any tool
// (annotate, update_element) or a malicious canvas import can mutate.
// Path separators / parent-directory escapes / NUL bytes have no
// legitimate use and would resolve outside the workspace files dir, so
// drop them before constructing any path.
function isSafeFileId(id: string): boolean {
  if (id.length === 0 || id.length > 256) return false
  if (id.includes('/') || id.includes('\\')) return false
  if (id.includes('\0')) return false
  if (id === '.' || id === '..') return false
  return true
}

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

const KNOWN_EXTS = Object.keys(EXT_TO_MIME)

export interface CanvasFile {
  mimeType: string
  id: string
  dataURL: string
  created: number
}

export async function loadCanvasFiles(
  workspaceId: string,
  referencedFileIds: ReadonlySet<string>,
): Promise<Record<string, CanvasFile>> {
  if (referencedFileIds.size === 0) return {}
  const dir = join(DATA_DIR, workspaceId, 'files')
  // Probe the directory once so a freshly-created workspace doesn't pay
  // for one stat() per referenced id when nothing is on disk yet.
  try {
    await stat(dir)
  } catch (err) {
    if (isMissingFileError(err)) return {}
    throw err
  }

  const out: Record<string, CanvasFile> = {}
  const resolvedDir = resolve(dir)
  for (const fileId of referencedFileIds) {
    if (!isSafeFileId(fileId)) continue
    for (const ext of KNOWN_EXTS) {
      const mime = EXT_TO_MIME[ext] as string
      const path = join(dir, `${fileId}${ext}`)
      // Belt + suspenders: even if isSafeFileId regresses, refuse to
      // read anything that resolves outside the per-workspace files dir.
      const resolved = resolve(path)
      if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + sep)) continue
      let buf: Buffer
      try {
        buf = await readFile(path)
      } catch (err) {
        if (isMissingFileError(err)) continue
        throw err
      }
      out[fileId] = {
        mimeType: mime,
        id: fileId,
        dataURL: `data:${mime};base64,${buf.toString('base64')}`,
        created: Date.now(),
      }
      // First match wins — multiple extensions for the same id would be
      // a bug in the file router, not something to handle here.
      break
    }
  }
  return out
}
