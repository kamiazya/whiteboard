import { parseOkf } from '@kamiazya/whiteboard-codec'
import { writeDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
import { WorkspaceNotFoundError as PortWorkspaceNotFoundError } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import type { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { WorkspaceDocumentNotFoundError, WorkspaceNotFoundError } from './document-crud.errors.js'
import type {
  wbDocumentCreateOutputSchema,
  wbDocumentDeleteInputSchema,
  wbDocumentDeleteOutputSchema,
  wbDocumentListInputSchema,
  wbDocumentListOutputSchema,
  wbDocumentResolveInputSchema,
  wbDocumentResolveOutputSchema,
} from './document-crud.schemas.js'
import { wbDocumentCreateInputSchema } from './document-crud.schemas.js'
import { saveDocumentSnapshot } from './document-io.js'
import { createDocumentSetTool, OkfParseError } from './document-set.js'

/**
 * The index refuses an unknown workspace in its own words; the tool surface
 * has said `WorkspaceNotFoundError` with its own advice since before the
 * index existed, and a caller reading the tool's error should not have to
 * learn a second name for the same condition.
 */
async function rethrowWorkspaceNotFound<T>(
  workspaceId: string,
  body: () => Promise<T>,
): Promise<T> {
  try {
    return await body()
  } catch (err) {
    if (err instanceof PortWorkspaceNotFoundError) {
      throw new WorkspaceNotFoundError(workspaceId)
    }
    throw err
  }
}

export async function wbDocumentCreate(
  deps: ServerDeps,
  rawInput: z.infer<typeof wbDocumentCreateInputSchema>,
): Promise<z.infer<typeof wbDocumentCreateOutputSchema>> {
  // Parsed here as well as at the MCP boundary. The union is what stops a
  // body being handed to a spatial document, and a caller reaching this
  // function directly — every test in this repo, and `createServer`'s own
  // routes — would otherwise skip that and have the content silently
  // dropped. A schema only guarantees what something actually runs.
  const input = wbDocumentCreateInputSchema.parse(rawInput)

  // Workspaces never materialize implicitly: a typo'd or hallucinated
  // workspaceId must fail loudly rather than silently writing data into a
  // workspace nobody asked for. `createWorkspace: true` is the explicit
  // opt-in that bootstraps a genuinely new workspace.
  if (input.createWorkspace === true) {
    await deps.documentIndex.createWorkspace({ workspaceId: input.workspaceId })
  }

  // Parsed before anything is written, and AFTER the workspace bootstrap so
  // a missing workspace still reports itself first. The body is applied by
  // delegating to `wb_document_set` once the document exists, so a
  // malformed one used to fail there — leaving an empty document squatting
  // the requested path while the caller held an error saying the create had
  // not happened, and the retry then collided with the ghost.
  if (input.kind === 'markdown' && input.markdown !== undefined) {
    const preflight = parseOkf(input.markdown)
    if (!preflight.ok) {
      throw new OkfParseError(preflight.error.stage, preflight.error.message)
    }
  }

  const entry = await rethrowWorkspaceNotFound(input.workspaceId, () =>
    deps.documentIndex.createDocument({
      workspaceId: input.workspaceId,
      path: input.path,
      kind: input.kind,
      ...(input.name === undefined ? {} : { name: input.name }),
    }),
  )

  // Persist the document, not only its placement. Creation used to write the
  // placement alone and leave the document to be conjured on first write,
  // which is why nothing could say what a document was: there was no
  // document yet to ask. The kind is written once, at birth.
  const doc = new LoroDoc()
  writeDocumentKind(doc, input.kind)
  await saveDocumentSnapshot(deps, input.workspaceId, entry.documentId, doc)

  // A body is written by DELEGATING to `wb_document_set` rather than by
  // repeating what it does. Its write is not a one-liner — it parses OKF,
  // decides what the document's kind may become, and projects frontmatter
  // into the model — and a second copy of that reasoning here would be a
  // second answer to the same question, drifting from the first the moment
  // either changes.
  if (input.kind === 'markdown' && input.markdown !== undefined) {
    await createDocumentSetTool(deps).execute({
      workspaceId: input.workspaceId,
      documentId: entry.documentId,
      markdown: input.markdown,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    })
  }

  return { documentId: entry.documentId, path: entry.path }
}

export async function wbDocumentResolve(
  deps: ServerDeps,
  input: z.infer<typeof wbDocumentResolveInputSchema>,
): Promise<z.infer<typeof wbDocumentResolveOutputSchema>> {
  const entry = await deps.documentIndex.resolveDocumentById({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
  })
  if (entry === null) {
    throw new WorkspaceDocumentNotFoundError(input.workspaceId, input.documentId)
  }
  return {
    documentId: entry.documentId,
    path: entry.path,
    ...(entry.name === undefined ? {} : { name: entry.name }),
  }
}

export async function wbDocumentList(
  deps: ServerDeps,
  input: z.infer<typeof wbDocumentListInputSchema>,
): Promise<z.infer<typeof wbDocumentListOutputSchema>> {
  // An unknown workspace is an error, not an empty list — otherwise a typo'd
  // workspaceId is indistinguishable from a genuinely empty workspace. The
  // index enforces that; this only restates it in the tool's vocabulary.
  const entries = await rethrowWorkspaceNotFound(input.workspaceId, () =>
    deps.documentIndex.listDocuments({ workspaceId: input.workspaceId }),
  )
  return {
    documents: entries.map((entry) => ({
      documentId: entry.documentId,
      path: entry.path,
      ...(entry.name === undefined ? {} : { name: entry.name }),
    })),
  }
}

export async function wbDocumentDelete(
  deps: ServerDeps,
  input: z.infer<typeof wbDocumentDeleteInputSchema>,
): Promise<z.infer<typeof wbDocumentDeleteOutputSchema>> {
  const entry = await deps.documentIndex.resolveDocumentById({
    workspaceId: input.workspaceId,
    documentId: input.documentId,
  })
  if (entry === null) {
    throw new WorkspaceDocumentNotFoundError(input.workspaceId, input.documentId)
  }
  // Before either delete: what the composition root has to clean up is only
  // discoverable while the document is still whole (see DocumentTeardown).
  const finalizeTeardown = await deps.documentTeardown.begin({
    workspaceId: input.workspaceId,
    documentId: entry.documentId,
    path: entry.path,
  })
  // Placement first: the index refuses while documents sit below this one, so
  // the bytes are only discarded once nothing can still be orphaned by it.
  // That refusal throws past the finalizer, which is what keeps a refused
  // delete from destroying anything.
  await deps.documentIndex.deleteDocument({
    workspaceId: input.workspaceId,
    path: entry.path,
  })
  await deps.documentStore.deleteDoc({
    docRef: { kind: 'document', workspaceId: input.workspaceId, documentId: entry.documentId },
  })
  await finalizeTeardown()
  return { deleted: true }
}
