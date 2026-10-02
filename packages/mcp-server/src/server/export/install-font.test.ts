// ADR-0012's write side. The read side (`installed-fonts.ts`) already exports
// with whatever is in the directory; this is how something legitimately gets
// there without the user hunting down a TTF by hand.
//
// The security shape is the point, not the download. The daemon is driven by
// AI agents that act on instructions found in documents, so the input is a
// catalogue ID and never a URL, and the request is built from a pinned
// template. Most of what is asserted below is that property holding.

import { mkdtempSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import {
  FONT_CATALOGUE,
  FONT_SOURCE_ORIGIN,
  fontCatalogueEntry,
  fontDownloadUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/fonts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { opentypeApi } from '../../shared/opentype.js'
import { syntheticFont } from '../../shared/test-utils/synthetic-font.js'
import { fontsDir as installedFontsDir } from '../tenant/data-layout.js'
import { FontInstallError, installFont, MAX_FONT_BYTES } from './install-font.js'
import { FONT_EXTENSIONS, installedFontFiles } from './installed-fonts.js'

const COVERED = 'こ'

let fontsDir: string

beforeEach(() => {
  fontsDir = installedFontsDir(mkdtempSync(join(tmpdir(), 'wb-font-install-')))
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** A file that parses as a font and declares zero glyphs: `maxp.numGlyphs` is the uint16 at byte 4 of that table. */
function fontDeclaringNoGlyphs(): ReturnType<typeof syntheticFont> {
  const bytes = syntheticFont(COVERED)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < view.getUint16(4); i++) {
    const entry = 12 + i * 16
    const tag = String.fromCharCode(...[0, 1, 2, 3].map((k) => view.getUint8(entry + k)))
    if (tag === 'maxp') view.setUint16(view.getUint32(entry + 8) + 4, 0)
  }
  // Guards the fixture: the file must still parse, or the test below would
  // pass for the wrong reason (the parse failing, not the glyph count).
  const parsed = opentypeApi.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  )
  expect(parsed.numGlyphs).toBe(0)
  return bytes
}

/** A body of `total` zero bytes, streamed in 1 MiB pieces so none is held at once. */
function zeroStream(total: number): ReadableStream<Uint8Array> {
  const piece = new Uint8Array(1024 * 1024)
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      const size = Math.min(piece.byteLength, total - sent)
      if (size === 0) return controller.close()
      controller.enqueue(piece.subarray(0, size))
      sent += size
    },
  })
}

/** Records what the installer asked for, and answers with `body`. */
function recordingFetch(body: BodyInit | null, init?: ResponseInit) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl = (async (input, requestInit) => {
    calls.push({ url: String(input), init: requestInit })
    return new Response(body, { status: 200, ...init })
  }) as typeof fetch
  return { impl, calls }
}

async function installedNames(): Promise<string[]> {
  return (await installedFontFiles(fontsDir)).map((path) => path.split('/').at(-1) ?? '')
}

describe('the catalogue', () => {
  it('is not empty, and every id is safe to use as a file name', () => {
    expect(FONT_CATALOGUE.length).toBeGreaterThan(0)
    for (const entry of FONT_CATALOGUE) {
      // The id becomes a path segment under the data directory. Anything that
      // could contain a separator or `..` would let the catalogue — not a
      // user, but still — write outside it.
      expect(entry.id).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('has unique ids', () => {
    const ids = FONT_CATALOGUE.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('builds every download URL on the pinned origin', () => {
    for (const entry of FONT_CATALOGUE) {
      expect(new URL(fontDownloadUrl(entry)).origin).toBe(FONT_SOURCE_ORIGIN)
    }
  })

  // A cap below the largest thing we offer would make that entry permanently
  // uninstallable, and the failure would look like a network fault.
  it('offers nothing larger than the size cap', () => {
    for (const entry of FONT_CATALOGUE) {
      expect(entry.approxBytes).toBeLessThan(MAX_FONT_BYTES)
    }
  })

  it('does not resolve an unknown id', () => {
    expect(fontCatalogueEntry('no-such-font')).toBeUndefined()
  })

  // An entry the reader ignores would download, report success, and render
  // exactly the tofu it was installed to fix.
  it('offers only extensions the export path reads back', () => {
    for (const entry of FONT_CATALOGUE) {
      expect(FONT_EXTENSIONS).toContain(extname(entry.path))
    }
  })

  // `new URL` resolves an authority-relative path against the host, not the
  // base path, so this is the one way a catalogue edit could retarget a
  // download without looking wrong.
  it('refuses to build a URL for an entry that escapes the pinned origin', () => {
    expect(() =>
      fontDownloadUrl({ ...FONT_CATALOGUE[0]!, path: '//example.com/evil.ttf' }),
    ).toThrow(/outside/)
  })
})

describe('installFont', () => {
  const known = () => FONT_CATALOGUE[0]!

  it('writes the font where the exporter reads it', async () => {
    const font = syntheticFont(COVERED)
    const { impl, calls } = recordingFetch(font)

    const installed = await installFont(known().id, { fontsDir, fetchImpl: impl })

    expect(installed.id).toBe(known().id)
    expect(installed.family).toBe(known().family)
    expect(installed.bytes).toBe(font.byteLength)
    expect(installed.path).toBe(join(fontsDir, `${known().id}.ttf`))
    // The whole point: the read side finds it without being told.
    expect(await installedFontFiles(fontsDir)).toContain(installed.path)
    expect(calls).toHaveLength(1)
  })

  it('requests exactly the pinned URL, refusing redirects and bounding the wait', async () => {
    const { impl, calls } = recordingFetch(syntheticFont(COVERED))

    await installFont(known().id, { fontsDir, fetchImpl: impl })

    expect(calls[0]?.url).toBe(fontDownloadUrl(known()))
    // A host that answers 302 could otherwise send the daemon anywhere, which
    // is the whole reason the input is an id rather than a URL.
    expect(calls[0]?.init?.redirect).toBe('error')
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  // The wait is bounded for the largest face on a slow connection, and long
  // enough that it never cuts a real download short.
  it('gives the download five minutes before it is abandoned', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const { impl } = recordingFetch(syntheticFont(COVERED))

    await installFont(known().id, { fontsDir, fetchImpl: impl })

    expect(timeout).toHaveBeenCalledWith(5 * 60 * 1000)
  })

  it('refuses an id that is not in the catalogue, without fetching anything', async () => {
    const { impl, calls } = recordingFetch(syntheticFont(COVERED))

    await expect(installFont('../../etc/passwd', { fontsDir, fetchImpl: impl })).rejects.toThrow(
      FontInstallError,
    )
    expect(calls).toHaveLength(0)
    expect(await installedFontFiles(fontsDir)).toEqual([])
  })

  it('keeps nothing that does not parse as a font', async () => {
    const { impl } = recordingFetch('<!doctype html><title>Not Found</title>')

    await expect(installFont(known().id, { fontsDir, fetchImpl: impl })).rejects.toMatchObject({
      reason: 'not-a-font',
    })
    // Not merely "no .ttf": a leftover temp file would be an unbounded litter
    // of failed downloads in the user's data directory.
    expect(await readdir(fontsDir).catch(() => [])).toEqual([])
  })

  it('keeps nothing from a font that declares no glyphs', async () => {
    const { impl } = recordingFetch(fontDeclaringNoGlyphs())

    await expect(installFont(known().id, { fontsDir, fetchImpl: impl })).rejects.toMatchObject({
      reason: 'not-a-font',
    })
    expect(await installedNames()).toEqual([])
  })

  it('treats an answer with no body as an unreachable source', async () => {
    const { impl } = recordingFetch(null)

    await expect(installFont(known().id, { fontsDir, fetchImpl: impl })).rejects.toMatchObject({
      reason: 'unreachable',
    })
    expect(await installedNames()).toEqual([])
  })

  it('keeps nothing when the source answers an error status', async () => {
    const { impl } = recordingFetch('nope', { status: 404 })

    await expect(installFont(known().id, { fontsDir, fetchImpl: impl })).rejects.toMatchObject({
      reason: 'unreachable',
    })
    expect(await installedNames()).toEqual([])
  })

  it('stops reading past the size cap even when Content-Length understates it', async () => {
    const chunk = new Uint8Array(1024)
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 16; i++) controller.enqueue(chunk)
        controller.close()
      },
    })
    // A lying header is the reason the cap is enforced on the stream rather
    // than on the declared length.
    const { impl } = recordingFetch(body, { headers: { 'content-length': '10' } })

    await expect(
      installFont(known().id, { fontsDir, fetchImpl: impl, maxBytes: 4 * 1024 }),
    ).rejects.toMatchObject({ reason: 'too-large' })
    expect(await installedNames()).toEqual([])
  })

  // The cap is on what was read, so a download of exactly the cap is within it.
  it('keeps a download of exactly the size cap and refuses one byte more', async () => {
    const font = syntheticFont(COVERED)

    await expect(
      installFont(known().id, {
        fontsDir,
        fetchImpl: recordingFetch(font).impl,
        maxBytes: font.byteLength,
      }),
    ).resolves.toMatchObject({ bytes: font.byteLength })
    await expect(
      installFont(known().id, {
        fontsDir,
        fetchImpl: recordingFetch(font).impl,
        maxBytes: font.byteLength - 1,
      }),
    ).rejects.toMatchObject({ reason: 'too-large' })
  })

  // Nothing in the catalogue overrides the cap, so the shipped default is the
  // limit every real install runs under. Sized from literals: the constant
  // cannot vouch for itself.
  it('allows a download of 32 MiB and refuses one byte more, with no override', async () => {
    const limit = 32 * 1024 * 1024
    const atLimit = recordingFetch(zeroStream(limit)).impl
    const overLimit = recordingFetch(zeroStream(limit + 1)).impl

    // Zeros are not a font, so reaching the parse is what "within the cap" means.
    await expect(installFont(known().id, { fontsDir, fetchImpl: atLimit })).rejects.toMatchObject({
      reason: 'not-a-font',
    })
    await expect(installFont(known().id, { fontsDir, fetchImpl: overLimit })).rejects.toMatchObject(
      { reason: 'too-large' },
    )
  })

  it('replaces an earlier install of the same font rather than accumulating files', async () => {
    const { impl } = recordingFetch(syntheticFont(COVERED))
    await installFont(known().id, { fontsDir, fetchImpl: impl })
    await installFont(known().id, {
      fontsDir,
      fetchImpl: recordingFetch(syntheticFont(COVERED)).impl,
    })

    expect(await installedNames()).toEqual([`${known().id}.ttf`])
  })
})
