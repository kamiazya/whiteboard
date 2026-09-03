/**
 * The daemon client's translation of "there is no picture".
 *
 * These cases used to live in `VersionThumbnail`'s test, back when the
 * component built the daemon's URL itself. They belong to the keeper: the
 * component now asks the seam and is told `null`, and only the daemon's
 * client knows that its route says so in three different ways.
 *
 * A BROWSER test, because the premise is a real `Response` carrying real
 * bytes and jsdom's cannot. Measured there:
 * `new Response(new Blob(['png']))` answers a 13-byte body reading
 * `"[object Blob]"` — the Blob is stringified, so an empty body has size 13
 * and a three-byte one has size 13 as well. Every assertion about a size or
 * about the bytes would have been testing the environment.
 */
import { describe, expect, it } from 'vitest'
import { createDaemonVersionsBackend, VersionsRequestError } from './versions-backend.js'

const backendOver = (respond: () => Response) =>
  createDaemonVersionsBackend((async () => respond()) as typeof globalThis.fetch)

describe('the daemon keeper answers "no picture" for every way its route says so', () => {
  it('404 — no such point, or one this document does not own', async () => {
    const backend = backendOver(() => new Response(null, { status: 404 }))
    expect(await backend.loadThumbnail('w', 'p', 'v')).toBeNull()
  })

  it('204 — a point that has none yet', async () => {
    // A success status, so it slips past an `ok` check; an object URL built
    // from its empty body renders as a broken image rather than as nothing.
    const backend = backendOver(() => new Response(null, { status: 204 }))
    expect(await backend.loadThumbnail('w', 'p', 'v')).toBeNull()
  })

  it('200 with an empty body — the same answer, however it arrives', async () => {
    const backend = backendOver(() => new Response(new Blob([]), { status: 200 }))
    expect(await backend.loadThumbnail('w', 'p', 'v')).toBeNull()
  })

  it('a refusal is raised, not swallowed into "no picture"', async () => {
    // 403 is not "there is none" — a caller that cannot tell the two apart
    // shows an empty row for a permission problem and nobody learns why.
    const backend = backendOver(() => new Response(null, { status: 403 }))
    await expect(backend.loadThumbnail('w', 'p', 'v')).rejects.toBeInstanceOf(VersionsRequestError)
  })

  it('bytes come back as bytes', async () => {
    const backend = backendOver(
      () => new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 }),
    )
    expect(await (await backend.loadThumbnail('w', 'p', 'v'))?.text()).toBe('png')
  })
})
