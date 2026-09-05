/**
 * What identifies one rendered picture of one document (ADR-0027 decision 2).
 *
 * The key crosses a worker boundary — and, once persistence lands, a storage
 * boundary — so it is a declared value type rather than a string built at each
 * call site, per this repo's Zod discipline. Three call sites concatenating
 * their own key is three chances to disagree, and the two that disagree serve
 * the wrong picture rather than failing.
 */

import { type DocumentKind, documentKindSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ResolvedTheme } from '../hooks/useThemeMode.js'

/**
 * Stamped into the bundle by every vite/vitest config (see
 * `renderer-build-id.ts`). Read with NO fallback on purpose: a config that
 * forgets the define throws here, loudly, instead of quietly keying every
 * deploy the same and serving a picture the current renderer would not draw.
 */
declare const __RENDERER_BUILD_ID__: string

export const RENDERER_BUILD_ID: string = __RENDERER_BUILD_ID__

/**
 * The families the broker holds, which is NOT every pipeline a surface can
 * take: `png-raster` is absent because nothing asks the broker for one, and
 * naming it here would claim a storage shape this key cannot address.
 * `render-surfaces.ts` widens this by exactly that member, so the two say the
 * same thing about the families they share.
 */
export const brokeredPipelineSchema = z.enum(['svg', 'outline'])

export type BrokeredPipeline = z.infer<typeof brokeredPipelineSchema>

export const renderKeySchema = z.object({
  /** The code that would produce these bytes. */
  buildId: z.string().min(1),
  /**
   * WHICH picture of the document, not just which document.
   *
   * The broker holds one map, so without this axis a tree row's outline and
   * a list row's SVG name the same entry — and the one that arrives first
   * answers the other, in a type the caller has no reason to check. A path
   * ending `.svg` while holding block geometry is the same mistake written
   * down.
   */
  pipeline: brokeredPipelineSchema,
  documentId: z.string().min(1),
  kind: documentKindSchema,
  /**
   * What the document's content WAS when it was drawn — a list row's content
   * digest, the open document's committed frontier — or null from a keeper
   * that cannot say.
   *
   * Null is not a version that happens to be missing — it is the absence of
   * any way to notice a change, so a key carrying it is NOT memoisable (see
   * `isMemoisableKey`). A re-read of the list produces the identical key, so
   * remembering a completed render under it would serve the old picture for
   * as long as the tab is open. It is also what stops persistence being safe
   * until a real frontier reaches this surface.
   */
  version: z.string().nullable(),
  /**
   * Set for a spatial document, whose palette is baked into the SVG, and
   * NULL for markdown, whose ink comes from CSS. That asymmetry is the whole
   * reason a markdown row survives a theme toggle: one entry serves both.
   */
  theme: z.enum(['light', 'dark']).nullable(),
})

export type RenderKey = z.infer<typeof renderKeySchema>

/**
 * The document fields a key is built from.
 *
 * `kind` is `DocumentKind` rather than a hand-written copy of its members:
 * a parallel union beside the schema is the drift this repo's Zod discipline
 * exists to prevent, and here it would let a new kind be keyed as one of the
 * old ones.
 */
export interface RenderKeySubject {
  readonly documentId: string
  readonly kind: DocumentKind
  /**
   * The identity of the document's content at the moment it is drawn — a
   * list row's `contentDigest`, the open document's committed frontier.
   * Opaque, equality only. Absent when the keeper cannot say, and then
   * nothing may be memoised (`isMemoisableKey`).
   *
   * Not a timestamp, and it was one: `updatedAt` is a register one replica
   * wrote, and a merge does not consult it. Measured, a replica's content
   * took on a state nobody had written while its stamp stayed put — so the
   * memo kept answering the old picture under an unchanged key.
   */
  readonly state?: string
}

/** The key for the SVG a surface draws at size — the expensive family. */
export function renderKeyOf(subject: RenderKeySubject, theme: ResolvedTheme): RenderKey {
  return {
    buildId: RENDERER_BUILD_ID,
    pipeline: 'svg',
    documentId: subject.documentId,
    kind: subject.kind,
    version: subject.state ?? null,
    // Baked into a spatial SVG's own bytes; a markdown one takes its ink
    // from page CSS, so one entry serves both themes.
    theme: subject.kind === 'spatial' ? theme : null,
  }
}

/**
 * The key for a document's OUTLINE — the rectangles a tree row's icon and
 * the tab favicon draw.
 *
 * It takes no theme, and that is the point rather than an omission: outline
 * colours are resolved from the light palette for both kinds, so a theme axis
 * would double the entries to hold identical rectangles and make a theme
 * toggle redraw every icon for nothing. A separate constructor rather than a
 * third argument, so no caller has to pass a theme that would be ignored.
 */
export function outlineKeyOf(subject: RenderKeySubject): RenderKey {
  return {
    buildId: RENDERER_BUILD_ID,
    pipeline: 'outline',
    documentId: subject.documentId,
    kind: subject.kind,
    version: subject.state ?? null,
    theme: null,
  }
}

/**
 * Whether a completed render may be remembered under this key.
 *
 * Only a key that can NOTICE a change may be: with `version: null` the key a
 * re-read produces is byte-identical to the one before it, so a memo would
 * answer with the old picture until the tab closes. A caller may still join
 * work already in flight for such a key — two panes asking in the same
 * instant are asking about the same bytes — which is why this is a property
 * of the memo and not of the whole broker.
 */
export function isMemoisableKey(key: RenderKey): boolean {
  return key.version !== null
}

/**
 * The path a worker may store this answer under, or `undefined` when it may
 * not remember it at all.
 *
 * Derived from `isMemoisableKey` rather than decided again, so the in-memory
 * map and the persistent tier cannot disagree about which entries are safe.
 * They must not: an entry the map refuses because it could not notice its
 * document changing would, on disk, outlive the tab as well.
 */
export function cacheKeyFor(key: RenderKey): string | undefined {
  return isMemoisableKey(key) ? renderKeyPath(key) : undefined
}

/**
 * One path segment, unambiguous whatever the value contains.
 *
 * Both `documentId` and the version are opaque strings from a keeper — the
 * daemon's document contract says so explicitly and is deliberately not
 * pattern-bound — so a `/` in either would otherwise move the boundary
 * between segments and let two different documents join to one path.
 * `encodeURIComponent` is reversible and escapes the separator; the `~`
 * prefix is what makes `.` and `..` impossible as whole segments, which
 * matters before the OPFS store exists rather than after.
 */
function segment(value: string): string {
  return `~${encodeURIComponent(value)}`
}

/**
 * The key as a path, build id first (ADR-0027 decision 5).
 *
 * Today it is the in-memory map's key; it is shaped as a path because that is
 * what the OPFS store will address, and a leading build id makes retiring a
 * build's whole cache one directory removal rather than a scan.
 */
/**
 * What a stored entry's bytes are — JSON for every family, and that is a
 * correction to this key's first sketch rather than an oversight.
 *
 * `.svg` was right while the entry was imagined as the picture alone. What a
 * caller actually needs back is the whole worker reply: an SVG AND the bounds
 * a consumer scales it to, or an outline's rectangles. Storing only the SVG
 * would mean re-deriving the extent by parsing its viewBox back out, to avoid
 * writing four numbers — and `layout`'s reply carries a `scene` and `anchors`
 * that are not optional on it, so an entry without them could not be served
 * back as one at all.
 *
 * The FAMILY is still named in the path, one segment up, which is what the
 * extension was carrying: a directory listing says `svg/` or `outline/`, and
 * a sweep can still drop one family the way it drops one build.
 */
const EXTENSION: Readonly<Record<BrokeredPipeline, string>> = {
  svg: 'json',
  outline: 'json',
}

export function renderKeyPath(key: RenderKey): string {
  const version = key.version ?? ''
  const leaf = key.theme === null ? segment(version) : `${segment(version)}-${key.theme}`
  // The pipeline sits under the build id and above the kind, so a sweep can
  // drop one family the way it can already drop one build: a directory.
  return `${segment(key.buildId)}/${key.pipeline}/${key.kind}/${segment(key.documentId)}/${leaf}.${EXTENSION[key.pipeline]}`
}
