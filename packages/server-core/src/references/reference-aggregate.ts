import { createUniqueNameResolver, scanReferences } from '@kamiazya/whiteboard-codec'
import {
  documentIdSchema,
  documentKindSchema,
  documentPathSchema,
} from '@kamiazya/whiteboard-model'
import { compareDocumentPaths } from '@kamiazya/whiteboard-ports'
import { snippetAround } from '@kamiazya/whiteboard-search'
import { z } from 'zod'

/**
 * The reference aggregation layer, designed around the Loro document
 * boundary. Three rules keep the boundary sound:
 *
 * 1. **References are derived facts, never content.** Nothing here is
 *    written back into any LoroDoc — a cross-document edge stored as CRDT
 *    content would need merge semantics of its own. This aggregate is a
 *    projection, rebuildable from the store at any time.
 * 2. **Extraction happens at the persistence boundary.** An event carries a
 *    whole document's replacement facts, extracted from a persisted
 *    snapshot — CRDT concurrency is resolved inside Loro before anything
 *    reaches this layer, so the aggregate never observes a mid-merge state.
 * 3. **Global joins stay outside the CRDT.** `[[Name]]` resolution depends
 *    on the workspace's name table (a document gains a backlink when a
 *    THIRD document's rename breaks a name's uniqueness — neither endpoint
 *    changed). Resolution therefore happens at query time against the
 *    current table, never at extraction time — an extracted fact can stay
 *    cached while its resolution changes under it.
 *
 * Events are per-document replacements tagged with a caller-supplied `seq`:
 * a stale event (lower seq than what the aggregate holds for that document,
 * tombstones included) is ignored, a duplicate is a no-op. That makes event
 * delivery order-tolerant and idempotent — the properties the command-based
 * PBT in reference-semantics.property.test.ts pins.
 *
 * `computeBacklinks` builds one of these from a full scan per request (the
 * non-incremental mode). Incremental wiring — save paths emitting events
 * into a long-lived instance — reuses this same class, so the two modes
 * cannot drift.
 */

const rawReferenceSchema = z
  .object({
    /**
     * The token as written: a document id, or a name/path to resolve at
     * query time. For `embed-node` it is always the embedded documentId;
     * for `file-node` it is the file value, matched against paths only.
     */
    target: z.string().min(1),
    via: z.enum(['wikilink', 'embed-node', 'file-node']),
    context: z.string(),
  })
  .strict()
export type RawReference = z.infer<typeof rawReferenceSchema>

const documentReferenceFactsSchema = z
  .object({
    path: documentPathSchema,
    name: z.string().min(1).optional(),
    kind: documentKindSchema.optional(),
    refs: z.array(rawReferenceSchema),
    /**
     * The document's raw prose — body and canvas text — kept alongside the
     * extracted refs because MENTION detection is a join against another
     * document's NAME, which extraction cannot know per-document.
     */
    texts: z.array(z.string()),
  })
  .strict()
export type DocumentReferenceFacts = z.infer<typeof documentReferenceFactsSchema>

export const backlinkEntrySchema = z
  .object({
    documentId: documentIdSchema,
    path: documentPathSchema,
    name: z.string().min(1).optional(),
    kind: documentKindSchema.optional(),
    /** One short plain-text excerpt per reference, in document order. */
    contexts: z.array(z.string()),
  })
  .strict()
export type BacklinkEntry = z.infer<typeof backlinkEntrySchema>

interface Held {
  readonly seq: number
  /** null is a tombstone: the document was removed at `seq`. */
  readonly facts: DocumentReferenceFacts | null
}

export class ReferenceAggregate {
  private readonly docs = new Map<string, Held>()

  /** Replace a document's facts. Ignored when `seq` is older than what is held. */
  upsert(documentId: string, seq: number, facts: DocumentReferenceFacts): void {
    const held = this.docs.get(documentId)
    if (held !== undefined && held.seq >= seq) return
    this.docs.set(documentId, { seq, facts })
  }

  /** Remove a document. The tombstone keeps `seq` so a late upsert stays dead. */
  remove(documentId: string, seq: number): void {
    const held = this.docs.get(documentId)
    if (held !== undefined && held.seq >= seq) return
    this.docs.set(documentId, { seq, facts: null })
  }

  /** The documents currently alive in the aggregate. */
  entries(): ReadonlyMap<string, DocumentReferenceFacts> {
    const alive = new Map<string, DocumentReferenceFacts>()
    for (const [id, held] of this.docs) if (held.facts !== null) alive.set(id, held.facts)
    return alive
  }

  has(documentId: string): boolean {
    return this.docs.get(documentId)?.facts != null
  }

  /**
   * Every live document referencing `documentId`, resolved against the
   * aggregate's CURRENT name table — the reader's rule exactly: `[[...]]`
   * may name a path or a display name, and an ambiguous name resolves to
   * nothing (mirrors apps/web's daemonLinkEntries + the codec resolver).
   */
  backlinksOf(documentId: string): BacklinkEntry[] {
    const alive = this.entries()
    const target = alive.get(documentId)
    if (target === undefined) return []

    const resolve = createUniqueNameResolver(
      [...alive].flatMap(([id, facts]) => [
        { id, name: facts.path },
        ...(facts.name === undefined ? [] : [{ id, name: facts.name }]),
      ]),
    )

    const backlinks: BacklinkEntry[] = []
    for (const [sourceId, facts] of alive) {
      if (sourceId === documentId) continue
      const contexts: string[] = []
      for (const ref of facts.refs) {
        if (resolvesTo(ref, documentId, target.path, resolve)) contexts.push(ref.context)
      }
      if (contexts.length === 0) continue
      backlinks.push({
        documentId: sourceId,
        path: facts.path,
        ...(facts.name === undefined ? {} : { name: facts.name }),
        ...(facts.kind === undefined ? {} : { kind: facts.kind }),
        contexts,
      })
    }
    // The listing order the DocumentIndex contract fixes (segment-wise path
    // compare), NOT map insertion order — the convergence property caught
    // insertion order varying with event arrival order. Path ties (two
    // sources briefly sharing a path never happens for an index-backed
    // feed, but events are not obliged to be index-consistent) fall back to
    // the id so the order stays total.
    backlinks.sort(
      (a, b) => compareDocumentPaths(a.path, b.path) || a.documentId.localeCompare(b.documentId),
    )
    return backlinks
  }
}

/**
 * Where `name` occurs in `text` OUTSIDE any `[[...]]` span — the ONE rule
 * both mention detection and linkify apply, so what the panel lists is
 * exactly what the linkify operation will rewrite.
 */
export function unlinkedNameSpans(
  text: string,
  name: string,
): readonly { index: number; length: number }[] {
  const refs = scanReferences(text).map(
    (match) => [match.index, match.index + match.full.length] as const,
  )
  const spans: { index: number; length: number }[] = []
  let cursor = 0
  for (;;) {
    const at = text.indexOf(name, cursor)
    if (at === -1) return spans
    cursor = at + name.length
    if (refs.some(([from, to]) => at >= from && at < to)) continue
    spans.push({ index: at, length: name.length })
  }
}

/**
 * Sources whose TEXT names `documentId`'s display name without a resolving
 * reference — the seeding half of the linking loop: the system finds the
 * candidate, a human confirms (a link is the author's claim, never a
 * statistic). Occurrences inside any `[[...]]` span are excluded whole —
 * target and alias halves alike — so an already-linking document surfaces
 * only its EXTRA prose mentions.
 */
export function mentionsOfIn(
  target: { readonly documentId: string; readonly name: string },
  sources: ReadonlyMap<string, DocumentReferenceFacts>,
): BacklinkEntry[] {
  const mentions: BacklinkEntry[] = []
  for (const [sourceId, facts] of sources) {
    if (sourceId === target.documentId) continue
    const contexts: string[] = []
    for (const text of facts.texts) {
      for (const span of unlinkedNameSpans(text, target.name)) {
        contexts.push(snippetAround(text, span.index, span.length))
        if (contexts.length >= 3) break
      }
      if (contexts.length >= 3) break
    }
    if (contexts.length === 0) continue
    mentions.push({
      documentId: sourceId,
      path: facts.path,
      ...(facts.name === undefined ? {} : { name: facts.name }),
      ...(facts.kind === undefined ? {} : { kind: facts.kind }),
      contexts,
    })
  }
  return mentions.sort(
    (a, b) => compareDocumentPaths(a.path, b.path) || a.documentId.localeCompare(b.documentId),
  )
}

function resolvesTo(
  ref: RawReference,
  targetId: string,
  targetPath: string,
  resolve: (alias: string) => string | null,
): boolean {
  switch (ref.via) {
    case 'embed-node':
      return ref.target === targetId
    case 'file-node':
      return ref.target === targetPath
    case 'wikilink':
      return documentIdSchema.safeParse(ref.target).success
        ? ref.target === targetId
        : resolve(ref.target) === targetId
  }
}
