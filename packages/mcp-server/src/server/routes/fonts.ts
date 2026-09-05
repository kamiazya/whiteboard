import { basename, extname } from 'node:path'
import type { ApiErrorBody } from '@kamiazya/whiteboard-daemon-client/api-contracts/errors'
import type {
  InstallFontResponse,
  ListFontsResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/fonts'
import { Hono } from 'hono'
import { FONT_CATALOGUE } from '../export/font-catalogue.js'
import { FontInstallError, installFont } from '../export/install-font.js'
import { installedFontFiles } from '../export/installed-fonts.js'

/**
 * The font picker's daemon surface.
 *
 * ADR-0012 keeps the trigger human: this is reachable from the browser UI and
 * from nothing else. It is deliberately NOT an MCP tool — the daemon is driven
 * by agents that act on instructions found in the documents they read, and a
 * tool that fetches would complete a prompt-injection-to-SSRF chain. Adding
 * one later is a decision that has to re-examine that sentence, not a natural
 * extension of this router.
 */
export interface FontsRouterDeps {
  /** Injected so a route test never reaches the network. */
  readonly install?: typeof installFont
}

export function createFontsRouter({ install = installFont }: FontsRouterDeps = {}) {
  const app = new Hono()

  app.get('/api/fonts', async (c) => {
    const stems = new Set((await installedFontFiles()).map((path) => basename(path, extname(path))))
    const response: ListFontsResponse = {
      fonts: FONT_CATALOGUE.map(({ path: _sourcePath, ...item }) => ({
        ...item,
        installed: stems.has(item.id),
      })),
    }
    return c.json(response)
  })

  app.post('/api/fonts/:id/install', async (c) => {
    try {
      const { id, family, bytes } = await install(c.req.param('id'))
      return c.json({ id, family, bytes } satisfies InstallFontResponse)
    } catch (err) {
      if (!(err instanceof FontInstallError)) throw err
      // The reason is the machine-readable half and the message is what the
      // picker shows; `apiErrorReason` only forwards a message that arrives
      // alongside an `error` code.
      return c.json(
        { error: err.reason, message: err.message } satisfies ApiErrorBody,
        // Only an unknown id is the caller's mistake. Everything else is the
        // upstream source failing, which is not this daemon's fault and not
        // something a retry of the same request will fix differently.
        err.reason === 'unknown-font' ? 404 : 502,
      )
    }
  })

  return app
}
