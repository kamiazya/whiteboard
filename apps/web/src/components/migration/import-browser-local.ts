import {
  apiErrorReason,
  createDocumentRequestSchema,
  createDocumentResponseSchema,
  documentApiUrl,
  updateDocumentResponseSchema,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import type { LoroLoadResult } from '../../lib/loro-store.js'

const MAX_CREATE_ATTEMPTS = 3

/**
 * Converts a canvas display name into a path matching the server's
 * validateDocumentPath charset (ASCII letters/digits/hyphen, no leading/trailing
 * hyphen, non-empty). Falls back to 'canvas' when nothing survives.
 */
export function toPathSegment(name: string): string {
  const collapsed = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return collapsed === '' ? 'canvas' : collapsed
}

/**
 * Imports a Loro snapshot plus its delta log into a throwaway LoroDoc and
 * exports one combined snapshot — the shape the daemon's /update route
 * expects (a fresh doc.import(bytes) call, not a delta stream).
 */
export function mergeToSnapshot(snapshot: Uint8Array, deltas: Uint8Array[]): Uint8Array {
  const doc = new Loro()
  doc.import(snapshot)
  for (const delta of deltas) doc.import(delta)
  return doc.export({ mode: 'snapshot' })
}

export type ImportOneCanvasResult =
  | { kind: 'ok'; path: string }
  | { kind: 'failed'; reason: string }

interface ImportOneCanvasOptions {
  fetch: typeof globalThis.fetch
  daemonBaseUrl: string
  workspaceId: string
  documentName: string
  documentKind: DocumentKind
  loroLoad: LoroLoadResult
}

function loroLoadFailureReason(kind: Exclude<LoroLoadResult['kind'], 'ok'>): string {
  switch (kind) {
    case 'not-found':
      return 'Canvas data was not found in this browser.'
    case 'corrupt-snapshot':
      return 'Canvas snapshot is corrupted and cannot be imported.'
    case 'corrupt-delta':
      return 'Canvas history is corrupted and cannot be imported.'
    case 'unsupported-version':
      return 'Canvas data uses an unsupported storage version.'
  }
}

async function parseErrorTitle(res: Response): Promise<string> {
  try {
    const reason = apiErrorReason(await res.json())
    if (reason !== undefined) return reason
  } catch {
    // fall through to the generic message below
  }
  return `Request failed (${res.status}).`
}

/**
 * Copy-first import of a single browser-local canvas: create it on the
 * daemon (retrying with a numeric path suffix on a name collision, bounded
 * to MAX_CREATE_ATTEMPTS), then push the merged snapshot. Never mutates or
 * deletes the source browser-local data — the caller owns that lifecycle.
 */
export async function importOneDocument(
  options: ImportOneCanvasOptions,
): Promise<ImportOneCanvasResult> {
  try {
    return await importOneDocumentUnsafe(options)
  } catch {
    // A thrown fetch (daemon offline, connection dropped mid-import) must
    // surface as a structured per-canvas failure, never a rejected promise
    // the batch loop has to defend against.
    return { kind: 'failed', reason: 'Could not reach the daemon (network error).' }
  }
}

async function importOneDocumentUnsafe(
  options: ImportOneCanvasOptions,
): Promise<ImportOneCanvasResult> {
  const { fetch, daemonBaseUrl, workspaceId, documentName, documentKind, loroLoad } = options

  if (loroLoad.kind !== 'ok') {
    return { kind: 'failed', reason: loroLoadFailureReason(loroLoad.kind) }
  }

  const baseSegment = toPathSegment(documentName)
  let createdPath: string | null = null

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const candidatePath = attempt === 0 ? baseSegment : `${baseSegment}-${attempt + 1}`
    const body = createDocumentRequestSchema.parse({ path: candidatePath, kind: documentKind })
    const res = await fetch(
      `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/documents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )

    if (res.status === 409) continue

    if (!res.ok) {
      return { kind: 'failed', reason: await parseErrorTitle(res) }
    }

    const json: unknown = await res.json()
    const parsed = createDocumentResponseSchema.safeParse(json)
    if (!parsed.success) {
      return { kind: 'failed', reason: 'Create response failed schema validation.' }
    }
    createdPath = parsed.data.path
    break
  }

  if (createdPath === null) {
    return {
      kind: 'failed',
      reason: `Could not find an available name after ${MAX_CREATE_ATTEMPTS} attempts.`,
    }
  }

  const mergedSnapshot = mergeToSnapshot(loroLoad.snapshot, loroLoad.deltas ?? [])

  const updateRes = await fetch(
    `${daemonBaseUrl}${documentApiUrl(workspaceId, createdPath, 'update')}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: mergedSnapshot as BodyInit,
    },
  )

  if (!updateRes.ok) {
    return { kind: 'failed', reason: await parseErrorTitle(updateRes) }
  }

  const updateJson: unknown = await updateRes.json()
  const updateParsed = updateDocumentResponseSchema.safeParse(updateJson)
  if (!updateParsed.success) {
    return { kind: 'failed', reason: 'Update response failed schema validation.' }
  }

  return { kind: 'ok', path: createdPath }
}
