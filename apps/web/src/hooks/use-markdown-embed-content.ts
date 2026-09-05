/**
 * Content loading for markdown `![[embed]]`s, the markdown sibling of
 * `useDocumentFileSeams`: the layout's `resolveEmbed` seam is SYNCHRONOUS by
 * contract, so this hook pre-fetches referenced bodies (direct and
 * transitive, naturally bounded by the layout's depth cap plus the cache)
 * and hands the preview a cache lookup. Totality mirrors the seam: a load
 * failure caches as "missing" — the preview keeps its placeholder and the
 * failed id is never re-fetched in a retry storm.
 */

import type { EmbeddedDocument } from '@kamiazya/whiteboard-canvas-render'
import {
  type AliasResolver,
  parseMarkdownBody,
  resolveReferences,
} from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { useCallback } from 'react'
import { getAppLogger } from '../lib/app-logger.js'
import { loadMarkdownEmbedSource } from '../lib/document-embed-content.js'
import { type PrefetchRequest, usePrefetchedCache } from './use-prefetched-cache.js'

const log = getAppLogger('markdown-embed-content')

/** What the layout's `resolveEmbed` seam answers: a parsed body or a canvas. */
export type MarkdownEmbedEntry = EmbeddedDocument

/**
 * A markdown target is its raw body (parsed here, once per load); a spatial
 * target is its canvas, which the layout draws as a miniature.
 */
export type MarkdownEmbedSource =
  | { readonly body: string; readonly title?: string }
  | { readonly canvas: SpatialCanvas; readonly title?: string }

export type MarkdownEmbedLoader = (documentId: string) => Promise<MarkdownEmbedSource | undefined>

/** Every embed documentId reachable in one parsed document. */
function collectEmbedIds(root: MdastRoot): readonly string[] {
  const ids: string[] = []
  const visit = (node: unknown) => {
    if (node === null || typeof node !== 'object') return
    const record = node as { type?: string; documentId?: string; children?: unknown[] }
    if (record.type === 'embed' && typeof record.documentId === 'string')
      ids.push(record.documentId)
    if (Array.isArray(record.children)) for (const child of record.children) visit(child)
  }
  visit(root)
  return [...new Set(ids)]
}

/** Total parse: a mid-edit body the schema rejects has no embeds to offer. */
function parseEmbeds(body: string, resolveAlias?: AliasResolver): readonly string[] {
  try {
    return collectEmbedIds(resolveReferences(parseMarkdownBody(body), resolveAlias))
  } catch {
    return []
  }
}

export function useMarkdownEmbedContent({
  body,
  resolveAlias,
  load = loadMarkdownEmbedSource,
}: {
  body: string
  resolveAlias?: AliasResolver
  /** Injection seam for tests; defaults to the browser's Loro loader. */
  load?: MarkdownEmbedLoader
}): (documentId: string) => MarkdownEmbedEntry | undefined {
  /**
   * One id, loaded and parsed. References resolve inside embedded bodies
   * too, so their own nested embeds become typed nodes the layout can
   * recurse into — and that `collect` below can discover on a later pass.
   *
   * Both failures answer `undefined`, which the cache records as terminal:
   * an id that does not load and one whose body does not parse are the same
   * answer to the seam, and neither is worth retrying on every keystroke.
   */
  const loadEntry = useCallback(
    async (documentId: string): Promise<MarkdownEmbedEntry | undefined> => {
      const source = await load(documentId).catch((err: unknown) => {
        log.warn('embed source load failed', { documentId, err })
        return undefined
      })
      if (source === undefined) return undefined
      const title = source.title !== undefined ? { title: source.title } : {}
      if ('canvas' in source) return { ...title, canvas: source.canvas }
      try {
        return {
          ...title,
          root: resolveReferences(parseMarkdownBody(source.body), resolveAlias),
        }
      } catch (err) {
        log.warn('embed source parse failed', { documentId, err })
        return undefined
      }
    },
    [load, resolveAlias],
  )

  return usePrefetchedCache<MarkdownEmbedEntry>(
    useCallback(
      (loaded) => {
        // The wanted set is the CLOSURE over what has already loaded: each
        // loaded body may reference further documents. The layout's depth
        // cap bounds what can ever be DRAWN, so over-fetching one level past
        // it is the acceptable cost of keeping this simple.
        const wanted = new Set(parseEmbeds(body, resolveAlias))
        for (const entry of loaded) {
          // A canvas's text nodes are parsed by the composer without
          // reference resolution, so nothing inside one can be an embed.
          if ('root' in entry) for (const id of collectEmbedIds(entry.root)) wanted.add(id)
        }
        return [...wanted].map(
          (id): PrefetchRequest<MarkdownEmbedEntry> => ({ key: id, load: () => loadEntry(id) }),
        )
      },
      [body, resolveAlias, loadEntry],
    ),
  )
}
