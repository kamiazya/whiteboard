import { z } from 'zod'

/**
 * A theme's family and where its bytes live — the whole of what a renderer
 * without a catalogue needs in order to go and get one.
 *
 * A URL rather than the bytes, deliberately: the families a theme can name
 * run to several megabytes each, and this payload rides an MCP tool result
 * through a model's context on every view. The one consumer that has to act
 * on it (the MCP Apps widget) is sandboxed markup with no daemon URL and no
 * credentials, so a URL is also the only form it could use.
 *
 * Declared here rather than in server-core because the widget validates it on
 * arrival and may not import server-core; this is the one package both
 * sides of that wire reach.
 */
export const themeFontSchema = z
  .object({
    family: z.string().min(1),
    url: z.string().min(1),
  })
  .strict()

export type ThemeFont = z.infer<typeof themeFontSchema>
