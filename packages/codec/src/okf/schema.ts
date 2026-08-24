import {
  coreFacetsSchema,
  extensionFacetsSchema,
  facetsRawSchema,
  okfTrustEventSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

/**
 * The OKF-Markdown envelope is codec-owned (this package decides how the
 * frontmatter/body pair is shaped), but every facet bucket it composes is
 * imported from model rather than re-declared — the single source of
 * truth for facet shapes stays model.
 */
export const okfMarkdownFrontmatterSchema = coreFacetsSchema.extend({
  // OKF v0.2's trust family (§5.2). Root keys the spec defines, so they sit
  // beside the core facets rather than under the `facets` extension bucket —
  // a consumer reading the bundle must not need this project's plugin
  // namespace to find who wrote a document.
  //
  // `verified` is stated as a list only. The bare mapping §5.2 makes a MUST
  // to accept is widened by `parseOkf` before this schema sees it, because a
  // schema carrying a transform cannot be converted to JSON Schema and this
  // one is published as `wb_document_get`'s outputSchema.
  generated: okfTrustEventSchema.optional(),
  verified: z.array(okfTrustEventSchema).optional(),
  facets: extensionFacetsSchema.optional(),
  facetsRaw: facetsRawSchema.optional(),
})

export type OkfMarkdownFrontmatter = z.infer<typeof okfMarkdownFrontmatterSchema>

export const okfMarkdownDocumentSchema = z.object({
  frontmatter: okfMarkdownFrontmatterSchema,
  body: z.string(),
})

export type OkfMarkdownDocument = z.infer<typeof okfMarkdownDocumentSchema>
