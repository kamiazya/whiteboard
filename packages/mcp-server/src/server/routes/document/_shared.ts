import { userInfo } from 'node:os'
import { corruptStoredDataBody } from '../../store/corrupt-stored-data.js'
import { DocumentNotFoundError } from '../../store/db/upsert-workspace.js'

export function defaultHumanDisplayName(): string {
  try {
    const name = userInfo().username.trim()
    if (name.length > 0) return name
  } catch {
    /* ignore */
  }
  return 'human'
}

export function handleCorruptStoredData(
  err: unknown,
): { status: 500; body: { error: 'corrupt_stored_data'; message: string } } | null {
  const body = corruptStoredDataBody(err)
  if (body) return { status: 500, body }
  return null
}

/**
 * Metadata writers (names, pins, branches, version save) refuse a path with
 * no document instead of minting a phantom row; routes answer that refusal
 * as 404 — the caller named a document that does not exist.
 */
export function handleDocumentNotFound(
  err: unknown,
): { status: 404; body: { error: 'not_found'; message: string } } | null {
  if (err instanceof DocumentNotFoundError) {
    return { status: 404, body: { error: 'not_found', message: err.message } }
  }
  return null
}
