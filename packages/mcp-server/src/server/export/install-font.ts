import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { z } from 'zod'
import { opentypeApi } from '../../shared/opentype.js'
import { getLogger } from '../log.js'
import { type FontCatalogueEntry, fontCatalogueEntry, fontDownloadUrl } from './font-catalogue.js'
import { installedFontDir } from './installed-fonts.js'

const log = getLogger('font-install')

/**
 * The largest download that will be kept. Comfortably above the biggest
 * catalogue entry (a CJK face is ~18 MB); `install-font.test.ts` fails if an
 * entry is ever added above it, since that entry could never install and the
 * failure would read as a network fault.
 */
export const MAX_FONT_BYTES = 32 * 1024 * 1024

/**
 * Bounds the whole request including the body read. Generous because the
 * largest face is ~18 MB on whatever connection the user has; the point is
 * that a stalled response cannot hold the daemon open indefinitely.
 */
const FETCH_TIMEOUT_MS = 5 * 60 * 1000

export const fontInstallFailureSchema = z.enum([
  /** No catalogue entry has this id. The only failure that is the caller's fault. */
  'unknown-font',
  'unreachable',
  'too-large',
  'not-a-font',
])

export type FontInstallFailure = z.infer<typeof fontInstallFailureSchema>

export class FontInstallError extends Error {
  readonly reason: FontInstallFailure

  constructor(reason: FontInstallFailure, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FontInstallError'
    this.reason = reason
  }
}

export interface InstallFontOptions {
  /** Injected so tests never reach the network. */
  readonly fetchImpl?: typeof fetch
  readonly maxBytes?: number
}

export interface InstalledFont {
  readonly id: string
  readonly family: string
  readonly path: string
  readonly bytes: number
}

/**
 * Download one catalogued font and keep it where the export path reads fonts.
 *
 * The input is a catalogue id, never a URL: the daemon is driven by AI agents
 * that act on instructions found in the documents they read, so a URL
 * parameter here would complete a prompt-injection-to-SSRF chain. This is also
 * why ADR-0012 keeps the trigger human — nothing in the MCP surface calls it.
 *
 * Everything the response says about itself is treated as hostile: redirects
 * are refused, the length is counted rather than believed, and the bytes must
 * parse as a font before anything is written. The file name comes from the
 * catalogue, never from the URL or a `Content-Disposition` header.
 */
export async function installFont(
  id: string,
  options: InstallFontOptions = {},
): Promise<InstalledFont> {
  const entry = fontCatalogueEntry(id)
  if (entry === undefined) {
    throw new FontInstallError('unknown-font', `No font in the catalogue is called ${id}.`)
  }

  const bytes = await download(entry, options)

  try {
    const font = opentypeApi.parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    )
    // A parse that succeeds on a file with no glyphs would install something
    // that renders exactly the tofu it was meant to fix.
    if (font.numGlyphs <= 0) throw new Error('the file declares no glyphs')
  } catch (err) {
    throw new FontInstallError(
      'not-a-font',
      `What ${entry.family} downloaded is not a usable font file.`,
      { cause: err },
    )
  }

  const dir = installedFontDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${entry.id}${extname(entry.path)}`)
  // Written beside the target and renamed, because a render running
  // concurrently would otherwise hand resvg a half-written file. The name is
  // unique per call so two installs of the same font cannot interleave into
  // one another's buffer; `installedFontFiles` ignores the extension either
  // way.
  const partial = `${path}.${randomUUID()}.partial`
  try {
    await writeFile(partial, bytes)
    await rename(partial, path)
  } catch (err) {
    await rm(partial, { force: true })
    throw err
  }

  log.notice({ id: entry.id, family: entry.family, bytes: bytes.byteLength }, 'installed font')
  return { id: entry.id, family: entry.family, path, bytes: bytes.byteLength }
}

async function download(entry: FontCatalogueEntry, options: InstallFontOptions): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxBytes = options.maxBytes ?? MAX_FONT_BYTES

  let response: Response
  try {
    response = await fetchImpl(fontDownloadUrl(entry), {
      // The control that makes "the daemon builds the URL" mean anything: a
      // source answering 302 could otherwise redirect it anywhere.
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    throw new FontInstallError('unreachable', `Could not download ${entry.family}.`, { cause: err })
  }

  if (!response.ok) {
    throw new FontInstallError(
      'unreachable',
      `Downloading ${entry.family} answered HTTP ${response.status}.`,
    )
  }
  if (response.body === null) {
    throw new FontInstallError('unreachable', `Downloading ${entry.family} returned no body.`)
  }

  // Counted rather than read from Content-Length, which a hostile or broken
  // source is free to understate.
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new FontInstallError(
          'too-large',
          `${entry.family} is larger than the ${maxBytes} byte limit.`,
        )
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  return Buffer.concat(chunks)
}
