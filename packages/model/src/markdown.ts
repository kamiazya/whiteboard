import { z } from 'zod'

/**
 * Markdown-format canvases carry a plain-text body — no structural schema.
 * Wiki links stay plain text (`[[canvas:<ULID>]]`) inside that string; the
 * markdown parser (mdast subset) is a separate concern from this envelope.
 */
export const markdownCanvasSchema = z.object({
  body: z.string(),
})

export type MarkdownCanvas = z.infer<typeof markdownCanvasSchema>
