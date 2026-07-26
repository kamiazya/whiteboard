import {
  coreFacetsSchema,
  extensionFacetsSchema,
  facetsRawSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'

/**
 * The OKF-Markdown envelope is codec-owned (this package decides how the
 * frontmatter/body pair is shaped), but every facet bucket it composes is
 * imported from canvas-model rather than re-declared — the single source of
 * truth for facet shapes stays canvas-model.
 */
export const okfMarkdownFrontmatterSchema = coreFacetsSchema.extend({
  facets: extensionFacetsSchema.optional(),
  facetsRaw: facetsRawSchema.optional(),
})

export type OkfMarkdownFrontmatter = z.infer<typeof okfMarkdownFrontmatterSchema>

export const okfMarkdownDocumentSchema = z.object({
  frontmatter: okfMarkdownFrontmatterSchema,
  body: z.string(),
})

export type OkfMarkdownDocument = z.infer<typeof okfMarkdownDocumentSchema>
