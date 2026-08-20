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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import { syntheticFont } from '../../shared/test-utils/synthetic-font.js'
import {
  FONT_CATALOGUE,
  FONT_SOURCE_ORIGIN,
  fontCatalogueEntry,
  fontDownloadUrl,
} from './font-catalogue.js'
import { FontInstallError, installFont, MAX_FONT_BYTES } from './install-font.js'
import { FONT_EXTENSIONS, installedFontDir, installedFontFiles } from './installed-fonts.js'

const COVERED = 'こ'

beforeEach(() => {
  setDataDirForTests(mkdtempSync(join(tmpdir(), 'wb-font-install-')))
})

afterEach(() => {
  resetDataDirForTests()
})

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
  return (await installedFontFiles()).map((path) => path.split('/').at(-1) ?? '')
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

    const installed = await installFont(known().id, { fetchImpl: impl })

    expect(installed.id).toBe(known().id)
    expect(installed.family).toBe(known().family)
    expect(installed.bytes).toBe(font.byteLength)
    expect(installed.path).toBe(join(installedFontDir(), `${known().id}.ttf`))
    // The whole point: the read side finds it without being told.
    expect(await installedFontFiles()).toContain(installed.path)
    expect(calls).toHaveLength(1)
  })

  it('requests exactly the pinned URL, refusing redirects and bounding the wait', async () => {
    const { impl, calls } = recordingFetch(syntheticFont(COVERED))

    await installFont(known().id, { fetchImpl: impl })

    expect(calls[0]?.url).toBe(fontDownloadUrl(known()))
    // A host that answers 302 could otherwise send the daemon anywhere, which
    // is the whole reason the input is an id rather than a URL.
    expect(calls[0]?.init?.redirect).toBe('error')
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses an id that is not in the catalogue, without fetching anything', async () => {
    const { impl, calls } = recordingFetch(syntheticFont(COVERED))

    await expect(installFont('../../etc/passwd', { fetchImpl: impl })).rejects.toThrow(
      FontInstallError,
    )
    expect(calls).toHaveLength(0)
    expect(await installedFontFiles()).toEqual([])
  })

  it('keeps nothing that does not parse as a font', async () => {
    const { impl } = recordingFetch('<!doctype html><title>Not Found</title>')

    await expect(installFont(known().id, { fetchImpl: impl })).rejects.toMatchObject({
      reason: 'not-a-font',
    })
    // Not merely "no .ttf": a leftover temp file would be an unbounded litter
    // of failed downloads in the user's data directory.
    expect(await readdir(installedFontDir()).catch(() => [])).toEqual([])
  })

  it('keeps nothing when the source answers an error status', async () => {
    const { impl } = recordingFetch('nope', { status: 404 })

    await expect(installFont(known().id, { fetchImpl: impl })).rejects.toMatchObject({
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
      installFont(known().id, { fetchImpl: impl, maxBytes: 4 * 1024 }),
    ).rejects.toMatchObject({ reason: 'too-large' })
    expect(await installedNames()).toEqual([])
  })

  it('replaces an earlier install of the same font rather than accumulating files', async () => {
    const { impl } = recordingFetch(syntheticFont(COVERED))
    await installFont(known().id, { fetchImpl: impl })
    await installFont(known().id, { fetchImpl: recordingFetch(syntheticFont(COVERED)).impl })

    expect(await installedNames()).toEqual([`${known().id}.ttf`])
  })
})
