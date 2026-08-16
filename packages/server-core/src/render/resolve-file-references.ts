import type { ResolvedReference } from '@kamiazya/whiteboard-canvas-render'
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import { readDocumentKind, readMarkdownBody } from '@kamiazya/whiteboard-crdt'
import {
  documentIdSchema,
  documentPathSchema,
  type SpatialCanvas,
  type WorkspaceId,
} from '@kamiazya/whiteboard-model'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { getLogger } from '../log.js'
import type { ServerDeps } from '../server-deps.js'

const log = getLogger('resolve-file-references')

/** Every file reference in a canvas, deduplicated. */
function fileRefs(canvas: SpatialCanvas): readonly string[] {
  return [...new Set(canvas.nodes.flatMap((node) => (node.type === 'file' ? [node.file] : [])))]
}

/**
 * Resolves one reference to the document it names.
 *
 * References are resolved by LOOKUP rather than by shape: a document id and
 * a document path are both plain strings whose alphabets overlap, so an id
 * that happens to look like a path (or the reverse) must not be decided by a
 * regex. The id lookup is tried first because a file node written today
 * stores an id — a path would dangle the moment the document moved.
 */
async function resolveEntry(deps: ServerDeps, workspaceId: WorkspaceId, ref: string) {
  if (documentIdSchema.safeParse(ref).success) {
    const byId = await deps.documentIndex.resolveDocumentById({
      workspaceId,
      documentId: ref,
    })
    if (byId !== null) return byId
  }
  if (!documentPathSchema.safeParse(ref).success) return null
  return await deps.documentIndex.resolveDocument({ workspaceId, path: ref })
}

/**
 * Pre-resolves every file reference in a canvas, so the SYNCHRONOUS seams
 * `layoutSpatialCanvas` takes become map lookups — the same shape apps/web's
 * editor uses, for the same reason.
 *
 * Only a MARKDOWN document yields a body. The kind comes from the document
 * itself rather than the index row, because the format follows from the
 * document (ADR-0009 decision 4) and the index's `kind` is absent on rows
 * that predate it. This matters more than it looks: a markdown document's
 * stored content is also a perfectly valid spatial canvas holding one text
 * node, so "does it parse as a canvas" cannot tell the two apart, and
 * rendering a diagram's first text node as if it were prose would misreport
 * what the reference points at.
 *
 * Total by construction: a reference that resolves to nothing, a snapshot
 * that fails to load, and a body that fails to parse each drop that ONE
 * reference (logged, since this layer has a logger) and leave the rest
 * resolving. A broken reference must never fail a whole render.
 */
export async function resolveFileReferences(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  canvas: SpatialCanvas,
): Promise<ReadonlyMap<string, ResolvedReference>> {
  // canvas-render's own record, not a parallel shape mapped at the seam:
  // every field it carries is something this function can answer, and two
  // near-identical types for one resolution is the drift class this repo
  // keeps paying for.
  const resolved = new Map<string, ResolvedReference>()

  await Promise.all(
    fileRefs(canvas).map(async (ref) => {
      try {
        const entry = await resolveEntry(deps, workspaceId, ref)
        if (entry === null) return

        const snapshot = await deps.documentStore.loadSnapshot({
          docRef: { kind: 'canvas', documentId: entry.documentId },
        })
        if (snapshot === null) {
          if (entry.name !== undefined) resolved.set(ref, { label: entry.name })
          return
        }

        const doc = new LoroDoc()
        doc.import(reassembleSnapshot(snapshot.manifest, snapshot.chunks))

        const label = entry.name
        if (readDocumentKind(doc) !== 'markdown') {
          if (label !== undefined) resolved.set(ref, { label })
          return
        }

        const body = readMarkdownBody(doc)
        resolved.set(ref, {
          ...(label !== undefined ? { label } : {}),
          // An empty body has no blocks, so the layout degrades to the card
          // on its own — no need to special-case it here.
          markdown: parseMarkdownBody(body),
        })
      } catch (err) {
        log.warning('file reference did not resolve; rendering it as a plain card', {
          workspaceId,
          ref,
          err,
        })
      }
    }),
  )

  return resolved
}
