import { z } from 'zod'

// An `isError` CallToolResult as the host relays it: the server puts the
// reason in its text content (`registerToolWithAnnotations` turns a thrown
// handler error into exactly that). Other content kinds carry nothing a
// person can read here, so they are skipped rather than refused.
const errorContentSchema = z.object({
  content: z.array(z.unknown()),
})
const textContentSchema = z.object({ type: z.literal('text'), text: z.string() })

/**
 * The reason a tool result gives for failing, or `undefined` when it gives
 * none the widget can show.
 */
export function toolErrorText(payload: unknown): string | undefined {
  const parsed = errorContentSchema.safeParse(payload)
  if (!parsed.success) return undefined
  const texts = parsed.data.content.flatMap((item) => {
    const text = textContentSchema.safeParse(item)
    return text.success && text.data.text.trim().length > 0 ? [text.data.text.trim()] : []
  })
  return texts.length > 0 ? texts.join('\n') : undefined
}
