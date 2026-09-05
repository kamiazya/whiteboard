import type { EmbeddedDocument, MdastLayoutOptions } from '@kamiazya/whiteboard-canvas-render'
import {
  type AliasResolver,
  parseMarkdownBody,
  resolveReferences,
  scanReferences,
} from '@kamiazya/whiteboard-codec'
import type { WorkspaceId } from '@kamiazya/whiteboard-model'
import { getLogger } from '../log.js'
import type { ServerDeps } from '../server-deps.js'
import { loadReferencedDocument, type ReferencedDocument } from './resolve-file-references.js'

const log = getLogger('resolve-embeds')

/**
 * The layout lays embeds out three deep and stops (`EMBED_DEPTH_CAP` in
 * canvas-render). Loading one level past that is the acceptable cost of
 * never having a body the layout would draw but this did not fetch.
 */
const LOAD_DEPTH = 4

/** The synchronous seams a markdown body's `[[...]]` and `![[...]]` need. */
export interface EmbedResolution {
  readonly resolveAlias: AliasResolver
  readonly resolveEmbed: NonNullable<MdastLayoutOptions['resolveEmbed']>
  readonly resolveTitle: NonNullable<MdastLayoutOptions['resolveTitle']>
}

/**
 * Pre-resolves every document the given bodies reference, transitively
 * through the markdown ones, so the layout's SYNCHRONOUS seams become map
 * lookups — the server-side twin of apps/web's `useMarkdownEmbedContent`.
 *
 * Aliases (paths) resolve through the index by lookup, never by shape, and
 * an alias that names nothing answers `null` so the reader keeps it as the
 * literal text the author wrote. A canvas is handed over whole: its text
 * nodes are laid out by the composer without reference resolution, the
 * same way every other surface draws them, so nothing inside one is
 * followed from here.
 *
 * Total: a target that fails to load is logged and left unresolved, and a
 * body that fails to parse resolves to nothing — never a failed render.
 */
export async function resolveEmbedTargets(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  bodies: readonly string[],
): Promise<EmbedResolution> {
  const aliases = new Map<string, string | null>()
  const documents = new Map<string, ReferencedDocument>()

  let frontier = bodies.map((body) => ({ body, depth: 0 }))
  while (frontier.length > 0) {
    const next: { body: string; depth: number }[] = []
    await Promise.all(
      frontier.flatMap(({ body, depth }) =>
        [...new Set(scanReferences(body).map((match) => match.target))].map(async (target) => {
          if (aliases.has(target)) return
          aliases.set(target, null)
          try {
            const source = await loadReferencedDocument(deps, workspaceId, target)
            if (source === null) return
            aliases.set(target, source.documentId)
            if (documents.has(source.documentId)) return
            documents.set(source.documentId, source)
            if (source.body !== undefined && depth + 1 < LOAD_DEPTH) {
              next.push({ body: source.body, depth: depth + 1 })
            }
          } catch (err) {
            log.warning('embed target did not resolve; leaving the reference literal', {
              workspaceId,
              target,
              err,
            })
          }
        }),
      ),
    )
    frontier = next
  }

  const resolveAlias: AliasResolver = (alias) => aliases.get(alias) ?? null
  const parsed = new Map<string, EmbeddedDocument | undefined>()
  return {
    resolveAlias,
    resolveTitle: (documentId) => documents.get(documentId)?.label,
    resolveEmbed: (documentId) => {
      if (parsed.has(documentId)) return parsed.get(documentId)
      const source = documents.get(documentId)
      let entry: EmbeddedDocument | undefined
      try {
        const title = source?.label !== undefined ? { title: source.label } : {}
        if (source?.canvas !== undefined) entry = { ...title, canvas: source.canvas }
        else if (source?.body !== undefined) {
          entry = {
            ...title,
            root: resolveReferences(parseMarkdownBody(source.body), resolveAlias),
          }
        }
      } catch (err) {
        log.warning('embedded body did not parse; rendering its placeholder', {
          workspaceId,
          documentId,
          err,
        })
      }
      parsed.set(documentId, entry)
      return entry
    },
  }
}
