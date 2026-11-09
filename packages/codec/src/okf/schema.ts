import {
  type OkfMarkdownFrontmatter,
  okfMarkdownFrontmatterSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

// The frontmatter schema is generated from `contracts/model` and owned by
// model; this package owns only the envelope that pairs it with a body.
//
// `verified` is a list only. The bare mapping OKF §5.2 makes a MUST to accept
// is widened by `parseOkf` before the schema sees it, because a schema carrying
// a transform cannot be converted to JSON Schema and this one is published as
// `wb_document_get`'s outputSchema.
export { type OkfMarkdownFrontmatter, okfMarkdownFrontmatterSchema }

export const okfMarkdownDocumentSchema = z.object({
  frontmatter: okfMarkdownFrontmatterSchema,
  body: z.string(),
})

export type OkfMarkdownDocument = z.infer<typeof okfMarkdownDocumentSchema>
