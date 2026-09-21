/**
 * Everything a document page derives from its keeper's document list in order
 * to resolve links: what a `[[path]]` resolves to, what a link is LABELLED
 * with, which refs point at nothing, and what the link picker may offer.
 *
 * It exists because all four were written once per page over the same shared
 * type. Three were identical; the fourth had drifted, which is what a
 * derivation duplicated per keeper does eventually — `missingFileRef` guarded
 * a missing `id` on one page and not the other.
 *
 * `LinkableDocument` is already the keeper-agnostic shape (`lib/link-entries`),
 * so this hook adds no adapter — the browser page projects its stored rows
 * onto it and the daemon's summaries are already it.
 */
import { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import { isImageRef } from '@kamiazya/whiteboard-model'
import { useMemo } from 'react'
import { type LinkableDocument, linkEntries, linkTargets, linkTitles } from '../lib/link-entries.js'
import type { LinkTarget } from '../lib/link-target.js'

export interface UseLinkResolutionOptions {
  /** The list every resolution reads: the workspace's documents. */
  readonly documents: readonly LinkableDocument[]
  /**
   * What the PICKER may offer, when that is not the same list.
   *
   * The browser page passes one: a rename's save races the list read, so the
   * open document's live snapshot is overlaid onto its listed row, or the
   * picker offers a stale name for the document being edited — or omits it
   * entirely right after it was created.
   *
   * That the two differ for the picker and NOT for `resolveTitle` is the
   * behaviour as it stands, faithfully reproduced here rather than tidied:
   * see `issues/link-resolution-derived-twice-per-page`.
   */
  readonly pickerDocuments?: readonly LinkableDocument[]
  /** The document being edited, which the picker never offers as a target. */
  readonly excludeDocumentId?: string
}

export interface LinkResolution {
  /** `[[path]]` -> a document, by unique-name resolution over the paths. */
  readonly resolveAlias: ReturnType<typeof createUniqueNameResolver>
  /**
   * A document id -> the label a link to it shows.
   *
   * Typed as whatever `linkTitles` answers rather than written out: this hook
   * PASSES the seam along and never builds one, which is the invariant
   * `tools/arch-lint`'s `reference-seams-check` holds — and a hand-written
   * signature here reads to that scan exactly like a hand-built seam.
   */
  readonly resolveTitle: ReturnType<typeof linkTitles>
  /**
   * Whether a stored ref points at nothing — a deleted document, or one
   * imported from elsewhere. Undefined while the list is empty, which keeps
   * everything ordinary before it has loaded: the editor draws a quiet
   * "Missing reference" only once there is a list to be missing from.
   */
  readonly missingFileRef: ((ref: string) => boolean) | undefined
  /** What the link picker offers. */
  readonly pickerTargets: readonly LinkTarget[]
}

export function useLinkResolution({
  documents,
  pickerDocuments = documents,
  excludeDocumentId,
}: UseLinkResolutionOptions): LinkResolution {
  const resolveAlias = useMemo(() => createUniqueNameResolver(linkEntries(documents)), [documents])
  const resolveTitle = useMemo(() => linkTitles(documents), [documents])

  const missingFileRef = useMemo(() => {
    if (documents.length === 0) return undefined
    // Both the id and the path, because a stored ref may be either: file
    // nodes key on the id (ADR-0008) and a legacy ref carries the path.
    // Image refs live in the file store rather than the documents list, so
    // they are never "missing" here.
    const known = new Set(documents.flatMap((entry) => [entry.id, entry.path]))
    return (ref: string) => !isImageRef(ref) && !known.has(ref)
  }, [documents])

  const pickerTargets = useMemo(
    () =>
      linkTargets(pickerDocuments, {
        ...(excludeDocumentId === undefined ? {} : { excludeDocumentId }),
      }),
    [pickerDocuments, excludeDocumentId],
  )

  return { resolveAlias, resolveTitle, missingFileRef, pickerTargets }
}
