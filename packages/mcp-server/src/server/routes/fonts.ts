import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ApiErrorBody } from '@kamiazya/whiteboard-daemon-client/api-contracts/errors'
import {
  FONT_CATALOGUE,
  type InstallFontResponse,
  type ListFontsResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/fonts'
import { Hono } from 'hono'
import { FontInstallError, installFont } from '../export/install-font.js'
import { installedFontFiles } from '../export/installed-fonts.js'

/**
 * What the browser is told a font file is. The daemon only ever installs
 * the extensions `installedFontFiles` admits, so a stem it found has one of
 * these; anything else is a file somebody dropped in by hand.
 */
const FONT_CONTENT_TYPE: Readonly<Record<string, string>> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
}

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

  // The bytes of an installed font, for the browser half of ADR-0012
  // decision 4: the app registers the same face the export draws with, so
  // a theme's family measures the same on screen and in a PNG. The id is
  // matched against what is on disk — never joined into a path — so a
  // request cannot name a file outside the font directory.
  app.get('/api/fonts/:id/file', async (c) => {
    const id = c.req.param('id')
    const file = (await installedFontFiles()).find((path) => basename(path, extname(path)) === id)
    if (file === undefined) {
      return c.json(
        { error: 'not_found', message: `No installed font ${id}.` } satisfies ApiErrorBody,
        404,
      )
    }
    const bytes = await readFile(file)
    return c.body(bytes, 200, {
      'Content-Type': FONT_CONTENT_TYPE[extname(file).toLowerCase()] ?? 'application/octet-stream',
      // Immutable for as long as the id names these bytes: a reinstall
      // writes the same catalogue file under the same id.
      'Cache-Control': 'private, max-age=86400',
    })
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
