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

export const renderKeySchema = z.object({
  /** The code that would produce these bytes. */
  buildId: z.string().min(1),
  documentId: z.string().min(1),
  kind: documentKindSchema,
  /**
   * What the document was when it was drawn, or null from a keeper that
   * stamps no time. Null keeps the entry usable within one sitting — the
   * list re-reads on mount, so a changed document arrives under a new
   * entry — and is what stops persistence being safe until a real frontier
   * reaches this surface.
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

export function renderKeyOf(subject: RenderKeySubject, theme: ResolvedTheme): RenderKey {
  return {
    buildId: RENDERER_BUILD_ID,
    documentId: subject.documentId,
    kind: subject.kind,
    version: subject.updatedAt ?? null,
    theme: subject.kind === 'spatial' ? theme : null,
  }
}

/**
 * The key as a path, build id first (ADR-0027 decision 5).
 *
 * Today it is the in-memory map's key; it is shaped as a path because that is
 * what the OPFS store will address, and a leading build id makes retiring a
 * build's whole cache one directory removal rather than a scan.
 */
export function renderKeyPath(key: RenderKey): string {
  const leaf =
    key.theme === null
      ? (key.version ?? 'unversioned')
      : `${key.version ?? 'unversioned'}-${key.theme}`
  return `${key.buildId}/${key.kind}/${key.documentId}/${leaf}.svg`
}
