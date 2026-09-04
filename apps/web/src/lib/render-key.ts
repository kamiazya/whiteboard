/**
 * What identifies one rendered picture of one document (ADR-0027 decision 2).
 *
 * The key crosses a worker boundary — and, once persistence lands, a storage
 * boundary — so it is a declared value type rather than a string built at each
 * call site, per this repo's Zod discipline. Three call sites concatenating
 * their own key is three chances to disagree, and the two that disagree serve
 * the wrong picture rather than failing.
 */

import { documentKindSchema } from '@kamiazya/whiteboard-model'
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
   * What the document was when it was drawn, or null from a keeper that
   * stamps no time.
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

/** The document fields a key is built from. */
export interface RenderKeySubject {
  readonly documentId: string
  readonly kind: 'spatial' | 'markdown'
  readonly updatedAt?: string
}

export function renderKeyOf(
  subject: RenderKeySubject,
  theme: ResolvedTheme,
  pipeline: BrokeredPipeline = 'svg',
): RenderKey {
  return {
    buildId: RENDERER_BUILD_ID,
    pipeline,
    documentId: subject.documentId,
    kind: subject.kind,
    version: subject.updatedAt ?? null,
    theme: subject.kind === 'spatial' ? theme : null,
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
 * What a family's bytes are. An outline is block geometry, so calling its
 * entry `.svg` would misdescribe it to the OPFS store and to anyone reading
 * a directory listing.
 */
const EXTENSION: Readonly<Record<BrokeredPipeline, string>> = {
  svg: 'svg',
  outline: 'json',
}

export function renderKeyPath(key: RenderKey): string {
  const version = key.version ?? ''
  const leaf = key.theme === null ? segment(version) : `${segment(version)}-${key.theme}`
  // The pipeline sits under the build id and above the kind, so a sweep can
  // drop one family the way it can already drop one build: a directory.
  return `${segment(key.buildId)}/${key.pipeline}/${key.kind}/${segment(key.documentId)}/${leaf}.${EXTENSION[key.pipeline]}`
}
