import { parseOkf } from '@kamiazya/whiteboard-codec'
import { writeDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId, workspaceSegmentSchema } from '@kamiazya/whiteboard-model'
import {
  isWorkspaceSegmentTakenError,
  WorkspaceNotFoundError as PortWorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import type { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import {
  WorkspaceDocumentNotFoundError,
  WorkspaceNotFoundError,
  WorkspaceSegmentUnusableError,
} from './document-crud.errors.js'
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

/**
 * ADR-0019's mint: a new workspace is keyed by a canonical ULID the server
 * chooses, and the handle the caller sent is filed as its `segment`.
 *
 * A handle that cannot BE a segment is refused rather than minted with none
 * — see `WorkspaceSegmentUnusableError` for why that is not the same choice
 * migration 0019 makes when backfilling workspaces that already exist.
 */
async function mintWorkspace(deps: ServerDeps, handle: string): Promise<string> {
  // The flag has always been an IDEMPOTENT bootstrap — a no-op when the
  // workspace is already there, which is why a caller can set it on every
  // request without keeping track. Minting unconditionally would break that:
  // a second create into the same workspace would mint a rival, and a handle
  // already resolved to a canonical id would be refused for being
  // ULID-shaped. So an existing workspace short-circuits, and only a handle
  // that names nothing reaches the mint.
  const existing = await deps.documentIndex.resolveWorkspace(handle)
  if (existing !== null) return existing.workspaceId

  if (!workspaceSegmentSchema.safeParse(handle).success) {
    throw new WorkspaceSegmentUnusableError(handle)
  }
  const workspaceId = generateDocumentId()
  try {
    await deps.documentIndex.createWorkspace({ workspaceId, segment: handle })
  } catch (err) {
    if (!isWorkspaceSegmentTakenError(err)) throw err
    // Another create bootstrapped this handle between the resolve above and
    // this write. The two cannot serialise on their own: each generates its
    // id BEFORE writing, and the keeper's write lock is keyed by that id, so
    // two mints of one handle take two different locks and only the unique
    // `segment` index notices. Converging on the winner is what keeps the
    // flag the idempotent bootstrap callers are told they may always set —
    // rethrowing would make it fail on timing alone.
    //
    // The loser leaves nothing behind: a keeper claims the registry identity
    // BEFORE the tree record precisely so a refused segment cannot strand a
    // half-created workspace.
    const winner = await deps.documentIndex.resolveWorkspace(handle)
    // Nothing answers to a segment the write just reported as taken: the row
    // is gone again, or this keeper does not resolve what it stores. Either
    // way it is not a race this can settle, so the original error stands.
    if (winner === null) throw err
    return winner.workspaceId
  }
  return workspaceId
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

  // Parsed BEFORE anything exists, so a refusal leaves nothing behind. The
  // body is applied by delegating to `wb_document_set` once the document
  // exists, so a malformed one used to fail there — leaving an empty
  // document squatting the requested path while the caller held an error
  // saying the create had not happened, and the retry then collided with
  // the ghost.
  //
  // It used to run AFTER the workspace bootstrap, "so a missing workspace
  // still reports itself first". That order cannot survive the mint below:
  // bootstrapping first would leave a freshly minted workspace behind every
  // refused body, and the caller's retry would mint a SECOND one. What the
  // old order bought was the error a caller gets when their request is
  // wrong in BOTH ways at once, which no test pins and which is the less
  // useful of the two — a malformed body has to be fixed either way.
  if (input.kind === 'markdown' && input.markdown !== undefined) {
    const preflight = parseOkf(input.markdown)
    if (!preflight.ok) {
      throw new OkfParseError(preflight.error.stage, preflight.error.message)
    }
  }

  // Workspaces never materialize implicitly: a typo'd or hallucinated
  // workspaceId must fail loudly rather than silently writing data into a
  // workspace nobody asked for. `createWorkspace: true` is the explicit
  // opt-in that bootstraps a genuinely new workspace.
  //
  // It is also ADR-0019's MINT BOUNDARY, and the only one on this side: the
  // SERVER decides the canonical id, and the string the caller sent becomes
  // the workspace's `segment`. Every later request may keep using that
  // string — segment-first resolution at the boundary turns it back into
  // this id — which is why the caller is not asked to change anything, and
  // why the minted id is REPORTED rather than merely stored.
  //
  // Everything below therefore works from `workspaceId`, never from
  // `input.workspaceId`: after a mint those name two different workspaces,
  // and reading the input again would file the document under one that does
  // not exist.
  const workspaceId =
    input.createWorkspace === true
      ? await mintWorkspace(deps, input.workspaceId)
      : input.workspaceId

  // Blank means no name, and that is a NORMALISATION rather than a rejection.
  // `DocumentEntry.name` is `z.string().min(1).optional()` — absent is the
  // meaningful "no name" state, where a reader falls back to the path
  // segment, and an empty string is neither: a name that reads as nothing,
  // which the port says cannot exist. But ADR-0006 point 3 is the older rule
  // and outranks tidiness here — naming must never gate creation — so a
  // caller sending a blank one gets a document, not an error.
  const name = input.name?.trim()
  const entry = await rethrowWorkspaceNotFound(workspaceId, () =>
    deps.documentIndex.createDocument({
      workspaceId,
      path: input.path,
      kind: input.kind,
      ...(name === undefined || name === '' ? {} : { name }),
    }),
  )

  // Persist the document, not only its placement. Creation used to write the
  // placement alone and leave the document to be conjured on first write,
  // which is why nothing could say what a document was: there was no
  // document yet to ask. The kind is written once, at birth.
  const doc = new LoroDoc()
  writeDocumentKind(doc, input.kind)
  await saveDocumentSnapshot(deps, workspaceId, entry.documentId, doc)

  // A body is written by DELEGATING to `wb_document_set` rather than by
  // repeating what it does. Its write is not a one-liner — it parses OKF,
  // decides what the document's kind may become, and projects frontmatter
  // into the model — and a second copy of that reasoning here would be a
  // second answer to the same question, drifting from the first the moment
  // either changes.
  if (input.kind === 'markdown' && input.markdown !== undefined) {
    await createDocumentSetTool(deps).execute({
      workspaceId,
      documentId: entry.documentId,
      markdown: input.markdown,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    })
  }

  return { workspaceId, documentId: entry.documentId, path: entry.path }
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
    // Same pass-through as the list below. These share `documentDetailSchema`,
    // so omitting them here would leave resolve DECLARING two fields it never
    // emits — a schema saying more than the runtime does, which is the drift
    // this repo keeps a single source of truth to prevent.
    ...(entry.kind === undefined ? {} : { kind: entry.kind }),
    ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
    ...(entry.shadowed === undefined ? {} : { shadowed: entry.shadowed }),
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
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
      ...(entry.shadowed === undefined ? {} : { shadowed: entry.shadowed }),
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
  // Both deletes run inside the composition root's bracket: what it has to
  // clean up is only discoverable while the document is still whole, and
  // whatever it holds around the delete (the daemon holds its per-workspace
  // write lock) has to cover both steps. See DocumentTeardown.
  return await deps.documentTeardown.around(
    {
      workspaceId: input.workspaceId,
      documentId: entry.documentId,
      path: entry.path,
    },
    async () => {
      // Placement first: the index refuses while documents sit below this
      // one, so the bytes are only discarded once nothing can still be
      // orphaned by it. That refusal throws past the bracket's cleanup,
      // which is what keeps a refused delete from destroying anything.
      await deps.documentIndex.deleteDocument({
        workspaceId: input.workspaceId,
        path: entry.path,
      })
      await deps.documentStore.deleteDoc({
        docRef: { kind: 'document', workspaceId: input.workspaceId, documentId: entry.documentId },
      })
      return { deleted: true }
    },
  )
}
