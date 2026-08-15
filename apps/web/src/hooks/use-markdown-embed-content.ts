/**
 * Content loading for markdown `![[embed]]`s, the markdown sibling of
 * `useCanvasFileSeams`: the layout's `resolveEmbed` seam is SYNCHRONOUS by
 * contract, so this hook pre-fetches referenced bodies (direct and
 * transitive, naturally bounded by the layout's depth cap plus the cache)
 * and hands the preview a cache lookup. Totality mirrors the seam: a load
 * failure caches as "missing" — the preview keeps its placeholder and the
 * failed id is never re-fetched in a retry storm.
 */
import {
  type AliasResolver,
  parseMarkdownBody,
  resolveReferences,
} from '@kamiazya/whiteboard-canvas-codec'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAppLogger } from '../lib/app-logger.js'
import { loadMarkdownEmbedSource } from '../lib/canvas-embed-content.js'

const log = getAppLogger('markdown-embed-content')

export interface MarkdownEmbedEntry {
  readonly title?: string
  readonly root: MdastRoot
}

export type MarkdownEmbedLoader = (
  canvasId: string,
) => Promise<{ body: string; title?: string } | undefined>

/** Every embed canvasId reachable in one parsed document. */
function collectEmbedIds(root: MdastRoot): readonly string[] {
  const ids: string[] = []
  const visit = (node: unknown) => {
    if (node === null || typeof node !== 'object') return
    const record = node as { type?: string; canvasId?: string; children?: unknown[] }
    if (record.type === 'embed' && typeof record.canvasId === 'string') ids.push(record.canvasId)
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
  /** Injection seam for tests; defaults to the browser-local Loro loader. */
  load?: MarkdownEmbedLoader
}): (canvasId: string) => MarkdownEmbedEntry | undefined {
  // `null` = load failed or target missing: a terminal answer that keeps the
  // resolver returning undefined without re-fetching the same id forever.
  const [cache, setCache] = useState<ReadonlyMap<string, MarkdownEmbedEntry | null>>(new Map())
  const inflight = useRef<Set<string>>(new Set())
  // Unmount-scoped, NOT effect-scoped: a keystroke re-runs the effect while
  // a load is in flight, and the new pass skips that id as inflight — so if
  // the old pass's completion were cancelled per-effect, the result would
  // be dropped with nothing left to ever re-fire it (the stuck-placeholder
  // bug). A completed load is valid whenever the component still lives.
  const unmounted = useRef(false)
  useEffect(() => {
    // Reset on the effect BODY, not just initialization: StrictMode's dev
    // double-mount runs this cleanup once before the real session, and a
    // flag that only ever goes true would silently drop every completion
    // for the component's whole life (dev-only, invisible in prod builds).
    unmounted.current = false
    return () => {
      unmounted.current = true
    }
  }, [])

  useEffect(() => {
    // The wanted set is the closure over what has already loaded: each
    // loaded body may reference further documents. The layout's depth cap
    // bounds what can ever be DRAWN, so over-fetching one level past it is
    // the acceptable cost of keeping this loop simple.
    const wanted = new Set(parseEmbeds(body, resolveAlias))
    for (const entry of cache.values()) {
      if (entry === null) continue
      for (const id of collectEmbedIds(entry.root)) wanted.add(id)
    }
    for (const id of wanted) {
      if (cache.has(id) || inflight.current.has(id)) continue
      inflight.current.add(id)
      void load(id)
        .catch((err: unknown) => {
          log.warn('embed source load failed', { canvasId: id, err })
          return undefined
        })
        .then((source) => {
          inflight.current.delete(id)
          if (unmounted.current) return
          let entry: MarkdownEmbedEntry | null = null
          if (source !== undefined) {
            try {
              // References resolve inside embedded bodies too, so their own
              // nested embeds become typed nodes the layout can recurse into
              // (and this loop can discover on the next pass).
              entry = {
                ...(source.title !== undefined ? { title: source.title } : {}),
                root: resolveReferences(parseMarkdownBody(source.body), resolveAlias),
              }
            } catch (err) {
              log.warn('embed source parse failed', { canvasId: id, err })
            }
          }
          setCache((prev) => new Map(prev).set(id, entry))
        })
    }
  }, [body, resolveAlias, cache, load])

  return useCallback((canvasId: string) => cache.get(canvasId) ?? undefined, [cache])
}
