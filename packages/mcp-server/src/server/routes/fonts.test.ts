import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  installFontResponseSchema,
  listFontsResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/fonts'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import { FONT_CATALOGUE } from '../export/font-catalogue.js'
import { FontInstallError } from '../export/install-font.js'
import { installedFontDir } from '../export/installed-fonts.js'
import { withTempDataDir } from './_test-helpers.js'
import { createFontsRouter } from './fonts.js'

const temp = withTempDataDir('wb-fonts-route-')

beforeEach(() => {
  setDataDirForTests(temp.dir)
})

afterEach(() => {
  resetDataDirForTests()
})

function serve(install?: Parameters<typeof createFontsRouter>[0]) {
  const app = new Hono()
  app.route('/', createFontsRouter(install))
  return app
}

describe('GET /api/fonts', () => {
  it('answers the catalogue, and never leaks the source path', async () => {
    const res = await serve().request('/api/fonts')

    expect(res.status).toBe(200)
    const body = listFontsResponseSchema.parse(await res.json())
    expect(body.fonts).toHaveLength(FONT_CATALOGUE.length)
    // The repository path is an implementation detail of where the daemon
    // fetches from; publishing it would invite a client to build its own URL,
    // which is the shape ADR-0012 exists to avoid.
    for (const font of body.fonts) expect(font).not.toHaveProperty('path')
  })

  it('reports nothing as installed on a fresh daemon', async () => {
    const body = listFontsResponseSchema.parse(await (await serve().request('/api/fonts')).json())

    expect(body.fonts.every((font) => font.installed === false)).toBe(true)
  })

  it('reports a font as installed once its file is on disk', async () => {
    const target = FONT_CATALOGUE[0]!
    await mkdir(installedFontDir(), { recursive: true })
    await writeFile(join(installedFontDir(), `${target.id}.ttf`), 'x')

    const body = listFontsResponseSchema.parse(await (await serve().request('/api/fonts')).json())

    expect(body.fonts.find((font) => font.id === target.id)?.installed).toBe(true)
    expect(body.fonts.filter((font) => font.installed)).toHaveLength(1)
  })
})

describe('POST /api/fonts/:id/install', () => {
  const target = () => FONT_CATALOGUE[0]!

  it('installs the requested font and answers what it kept', async () => {
    const install = vi
      .fn()
      .mockResolvedValue({ id: target().id, family: target().family, path: '/x.ttf', bytes: 42 })

    const res = await serve({ install }).request(`/api/fonts/${target().id}/install`, {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    expect(installFontResponseSchema.parse(await res.json())).toEqual({
      id: target().id,
      family: target().family,
      bytes: 42,
    })
    expect(install).toHaveBeenCalledWith(target().id)
  })

  it('answers 404 for an id the catalogue does not have', async () => {
    const install = vi
      .fn()
      .mockRejectedValue(new FontInstallError('unknown-font', 'No font in the catalogue.'))

    const res = await serve({ install }).request('/api/fonts/not-a-font/install', {
      method: 'POST',
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'unknown-font' })
  })

  // A source that is down is not the caller's fault, and the picker has to be
  // able to tell "you asked for something that does not exist" from "try
  // again later".
  it.each([
    'unreachable',
    'too-large',
    'not-a-font',
  ] as const)('answers 502 when the download fails with %s', async (reason) => {
    const install = vi.fn().mockRejectedValue(new FontInstallError(reason, 'nope'))

    const res = await serve({ install }).request(`/api/fonts/${target().id}/install`, {
      method: 'POST',
    })

    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: reason, message: 'nope' })
  })

  it('does not swallow an unexpected error as a font problem', async () => {
    const install = vi.fn().mockRejectedValue(new Error('disk on fire'))

    const res = await serve({ install }).request(`/api/fonts/${target().id}/install`, {
      method: 'POST',
    })

    expect(res.status).toBe(500)
  })
})
