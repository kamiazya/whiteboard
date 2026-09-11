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
 */
export const themeFontSchema = z
  .object({
    family: z.string().min(1),
    url: z.string().min(1),
  })
  .strict()

type ThemeFont = z.infer<typeof themeFontSchema>

/**
 * Where a family a theme names can be downloaded, or nothing when the
 * catalogue does not know it.
 *
 * A seam rather than a dependency, for the reason `measure` is one: the
 * catalogue lives in `daemon-client`, which this shared layer may not
 * import (it depends on server-core, so the edge would close a cycle).
 * The composition root wires it.
 */
export type ThemeFontSource = (family: string) => ThemeFont | undefined
