import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { SnapshotNotFoundError } from '../document-io.js'
import {
  WorkspaceDocumentNotFoundError,
  WorkspaceNotFoundForCallerError,
} from './document-crud.errors.js'

/**
 * What a tool tells a caller whose address names nothing, decided once for the
 * whole tool record instead of per tool.
 *
 * A mistyped workspace or document is the commonest failure a model has, and
 * the refusal is the only place the next step can reach it. Left to each tool
 * it came out as five different sentences — advice to ADD a document given to
 * a read, the id a caller never typed, a "no saved snapshot" for a document
 * that never existed — because each tool reached the condition through
 * whichever seam it happened to call first.
 */

/** Where the list of workspaces that do exist comes from; absent says nothing about them. */
export type KnownWorkspaceHandles = () => Promise<readonly string[]>

/**
 * A tool that takes `createWorkspace` states its own intent: whether the
 * refusal should offer that flag depends on which ops the batch carries, which
 * only the tool can read.
 */
export function ownsWorkspaceRefusal(tool: { inputSchema?: unknown }): boolean {
  const shape = (tool.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape
  return shape !== undefined && 'createWorkspace' in shape
}

/** The advice-bearing refusal for a handle nothing answers to, in a read's vocabulary. */
export async function unknownWorkspaceRefusal(
  handle: string,
  known: KnownWorkspaceHandles | undefined,
): Promise<WorkspaceNotFoundForCallerError> {
  return new WorkspaceNotFoundForCallerError(handle, 'read', (await known?.()) ?? [])
}

/**
 * Re-says a refusal in the words the caller used.
 *
 * The tools see the workspace's canonical id, because that is what the handle
 * resolves to before they run; a caller who addressed it by segment never
 * typed that string, so a refusal quoting it names nothing they can check.
 * A snapshot that is missing for a document the workspace does not hold is a
 * missing DOCUMENT, and says so — "no saved snapshot" is the right sentence
 * only for a document that exists and was never saved.
 */
export async function inTheCallersWords(
  err: unknown,
  ctx: {
    index: DocumentIndex
    handle: string
    workspaceId: string
    documentId: unknown
  },
): Promise<unknown> {
  if (
    err instanceof SnapshotNotFoundError &&
    typeof ctx.documentId === 'string' &&
    (await ctx.index.resolveDocumentById({
      workspaceId: ctx.workspaceId,
      documentId: ctx.documentId,
    })) === null
  ) {
    return new WorkspaceDocumentNotFoundError(ctx.handle, ctx.documentId)
  }
  if (!(err instanceof Error) || ctx.handle === ctx.workspaceId) return err
  if (!err.message.includes(ctx.workspaceId)) return err
  const rewritten = new Error(err.message.replaceAll(ctx.workspaceId, ctx.handle), { cause: err })
  rewritten.name = err.name
  return rewritten
}
