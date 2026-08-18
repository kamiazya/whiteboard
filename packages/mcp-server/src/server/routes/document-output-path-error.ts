import type { OutputPathError } from '../output-path.js'

export type DocumentOutputPathErrorBody = {
  status: 400 | 409
  body: { error: string; message: string }
}

// The fixed messages below intentionally never echo err.message: it can
// contain the caller-supplied outputPath, which may point anywhere on disk
// (e.g. into another user's home directory) and would leak that layout back
// to the caller. workspaceId is safe to include — the caller already knows
// it, since it is part of the request URL — and naming the allowed root
// turns "Invalid output path." from a dead end into an actionable message.
export function toDocumentOutputPathErrorBody(
  err: OutputPathError,
  workspaceId: string,
): DocumentOutputPathErrorBody {
  if (err.code === 'output_exists') {
    return { status: 409, body: { error: err.code, message: 'Output file already exists.' } }
  }
  if (err.code === 'invalid_output_path') {
    return {
      status: 400,
      body: {
        error: err.code,
        message: `Invalid output path. outputPath must be inside this workspace's exports directory (~/.whiteboard/${workspaceId}/exports, or $WHITEBOARD_DATA_DIR/${workspaceId}/exports if that env var is set). Omit outputPath to write there automatically.`,
      },
    }
  }
  return { status: 400, body: { error: err.code, message: 'Export output path rejected.' } }
}
