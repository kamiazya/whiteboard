import type { ResolvedReference } from '@kamiazya/whiteboard-canvas-render'
import {
  type AliasResolver,
  parseMarkdownBody,
  resolveReferences,
} from '@kamiazya/whiteboard-codec'
import {
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  documentIdSchema,
  documentPathSchema,
  type SpatialCanvas,
  type WorkspaceId,
} from '@kamiazya/whiteboard-model'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
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
 * stores an id — a path would dangle the moment the document moved — and
 * because the reader gives `[[<id>]]` the same precedence.
 */
async function resolveDocumentEntry(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  ref: string,
): Promise<DocumentEntry | null> {
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
 * What one referenced document IS, before anything is parsed: its name, and
 * its content in the one form its kind allows. Only a MARKDOWN document
 * yields a body and only a SPATIAL one a canvas. The kind comes from the
 * document itself rather than the index row, because the format follows
 * from the document (ADR-0009 decision 4) and the index's `kind` is absent
 * on rows that predate it. This matters more than it looks: a markdown
 * document's stored content is also a perfectly valid spatial canvas holding
 * one text node, so "does it parse as a canvas" cannot tell the two apart,
 * and rendering a diagram's first text node as if it were prose would
 * misreport what the reference points at.
 */
export interface ReferencedDocument {
  readonly documentId: string
  readonly label?: string
  readonly body?: string
  readonly canvas?: SpatialCanvas
}

/**
 * Loads the document behind one reference, or `null` when nothing is
 * indexed under it. A document whose snapshot is gone still answers its
 * name, so the card can say what it pointed at.
 */
export async function loadReferencedDocument(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  ref: string,
): Promise<ReferencedDocument | null> {
  const entry = await resolveDocumentEntry(deps, workspaceId, ref)
  if (entry === null) return null
  const label = entry.name !== undefined ? { label: entry.name } : {}

  const snapshot = await deps.documentStore.loadSnapshot({
    docRef: { kind: 'document', workspaceId, documentId: entry.documentId },
  })
  if (snapshot === null) return { documentId: entry.documentId, ...label }

  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(snapshot.manifest, snapshot.chunks))
  const kind = readDocumentKind(doc) ?? entry.kind
  if (kind === 'markdown') {
    return { documentId: entry.documentId, ...label, body: readMarkdownBody(doc) }
  }
  if (kind === 'spatial') {
    return { documentId: entry.documentId, ...label, canvas: readSpatialCanvas(doc) }
  }
  return { documentId: entry.documentId, ...label }
}

/**
 * canvas-render's own record for one loaded document, not a parallel shape
 * mapped at the seam: every field it carries is something this module can
 * answer, and two near-identical types for one resolution is the drift
 * class this repo keeps paying for. A markdown body is parsed here, once,
 * with the alias resolver the caller has (absent, only `![[<id>]]` inside
 * it resolves). An empty body has no blocks, so the layout degrades to the
 * card on its own — no need to special-case it.
 */
export function toResolvedReference(
  source: ReferencedDocument,
  resolveAlias?: AliasResolver,
): ResolvedReference {
  return {
    ...(source.label !== undefined ? { label: source.label } : {}),
    ...(source.canvas !== undefined ? { canvas: source.canvas } : {}),
    ...(source.body !== undefined
      ? { markdown: resolveReferences(parseMarkdownBody(source.body), resolveAlias) }
      : {}),
  }
}

/**
 * Loads every file reference in a canvas, so the SYNCHRONOUS seams
 * `layoutSpatialCanvas` takes become map lookups — the same shape apps/web's
 * editor uses, for the same reason.
 *
 * Total by construction: a reference that resolves to nothing, a snapshot
 * that fails to load, and a body that fails to read each drop that ONE
 * reference (logged, since this layer has a logger) and leave the rest
 * resolving. A broken reference must never fail a whole render.
 */
export async function loadFileReferences(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  canvas: SpatialCanvas,
): Promise<ReadonlyMap<string, ReferencedDocument>> {
  const loaded = new Map<string, ReferencedDocument>()
  await Promise.all(
    fileRefs(canvas).map(async (ref) => {
      try {
        const source = await loadReferencedDocument(deps, workspaceId, ref)
        if (source !== null) loaded.set(ref, source)
      } catch (err) {
        log.warning('file reference did not resolve; rendering it as a plain card', {
          workspaceId,
          ref,
          err,
        })
      }
    }),
  )
  return loaded
}

/**
 * `loadFileReferences` parsed into canvas-render's records. The one-step
 * form for a caller with no alias resolver of its own (`canvas_view`); the
 * render tool loads, resolves the bodies' own references, then parses.
 */
export async function resolveFileReferences(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  canvas: SpatialCanvas,
): Promise<ReadonlyMap<string, ResolvedReference>> {
  const loaded = await loadFileReferences(deps, workspaceId, canvas)
  return new Map([...loaded].map(([ref, source]) => [ref, toResolvedReference(source)]))
}
