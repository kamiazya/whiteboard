import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

/**
 * What ONE referenced document is, once a keeper has loaded it — the record
 * every composition root fills in and the only input the seams below read.
 *
 * Every field is optional and independent, because a keeper supplies what
 * it has: a document the index knows but whose content is gone answers its
 * name alone; a markdown document its raw `body`; a spatial one its
 * `canvas`. The record deliberately does not say WHICH it is: a markdown
 * document stored the pre-container way reads back as a canvas holding one
 * text node too, so "has a body" is what says markdown, wherever it was
 * written (`referenceSeams` applies that rule once, for every surface).
 *
 * Raw rather than parsed, so a keeper's job stops at reaching its store;
 * parsing happens once per record inside the seams, never inside a layout
 * call.
 */
export interface LoadedReference {
  /** The canonical id the reference resolved to, when a keeper's index knows it. */
  readonly documentId?: string
  /** The document's display name — the workspace's, never the content's (ADR-0009). */
  readonly name?: string
  /** A markdown document's raw body. */
  readonly body?: string
  /** A spatial document's canvas. */
  readonly canvas?: SpatialCanvas
}

/**
 * Everything a render knows about the documents it points at, keyed by the
 * reference AS WRITTEN — a file node's `file`, a `[[target]]`'s target, an
 * id — with `null` for a key that was looked up and names nothing. The
 * distinction matters to a caller that prefetches: absent means "not
 * fetched yet", `null` means "fetched, and there is nothing", and only the
 * first is worth fetching again.
 */
export type ReferenceGraph = ReadonlyMap<string, LoadedReference | null>
