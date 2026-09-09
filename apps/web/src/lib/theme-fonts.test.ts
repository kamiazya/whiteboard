// The families a theme names reach this app from the daemon (ADR-0012's
// browser half, for exactly those families): fetched once, registered on
// the main thread, and handed to every layout worker — the ones alive and
// the ones spawned later — so both realms measure the same face.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const registerFontBytes = vi.fn(async (_family: string, _bytes: ArrayBuffer) => 'loaded' as const)
vi.mock('@kamiazya/whiteboard-canvas-viewer/font-loading', () => ({
  registerFontBytes: (family: string, bytes: ArrayBuffer) => registerFontBytes(family, bytes),
  hasLoadedFace: () => false,
}))

const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

function daemonFetch(installed: readonly { id: string; family: string }[]) {
  const calls: string[] = []
  const fetchFn = vi.fn(async (input: Request | string | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/api/fonts')) {
      return new Response(
        JSON.stringify({
          fonts: installed.map((f) => ({
            ...f,
            scripts: ['Japanese'],
            license: 'OFL-1.1',
            approxBytes: 1,
            installed: true,
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const m = /\/api\/fonts\/([^/]+)\/file$/.exec(url)
    if (m) return new Response(bytesOf(`font:${m[1]}`), { status: 200 })
    return new Response('nope', { status: 404 })
  }) as unknown as typeof globalThis.fetch
  return { fetchFn, calls }
}

describe('theme fonts', () => {
  beforeEach(() => {
    vi.resetModules()
    registerFontBytes.mockClear()
  })
  afterEach(() => {
    vi.resetModules()
  })

  it('fetches only the installed families a registered theme names, registers them, and remembers', async () => {
    const mod = await import('./theme-fonts.js')
    const { fetchFn, calls } = daemonFetch([
      { id: 'yomogi', family: 'Yomogi' },
      { id: 'noto-sans-jp', family: 'Noto Sans JP' },
    ])
    expect(mod.themeFontFamilies()).toContain('Yomogi')

    const loaded = await mod.loadThemeFonts({ fetchFn, daemonBaseUrl: 'http://d' })
    expect(loaded).toEqual(['Yomogi'])
    expect(calls.filter((u) => u.endsWith('/file'))).toEqual(['http://d/api/fonts/yomogi/file'])
    expect(registerFontBytes).toHaveBeenCalledTimes(1)
    expect(mod.loadedThemeFaces().map((f) => f.family)).toEqual(['Yomogi'])

    // A second pass is a no-op: the face is held, and nothing is refetched.
    await mod.loadThemeFonts({ fetchFn, daemonBaseUrl: 'http://d' })
    expect(calls.filter((u) => u.endsWith('/file'))).toHaveLength(1)
  })

  it('hands every held face to a worker attached before or after the face arrived', async () => {
    const mod = await import('./theme-fonts.js')
    const early = { postMessage: vi.fn() }
    const stop = mod.attachThemeFaces(early)
    const { fetchFn } = daemonFetch([{ id: 'yomogi', family: 'Yomogi' }])
    const before = mod.themeFontsGeneration()
    await mod.loadThemeFonts({ fetchFn, daemonBaseUrl: 'http://d' })
    expect(mod.themeFontsGeneration()).toBe(before + 1)
    expect(early.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'register-face', family: 'Yomogi' }),
    )

    const late = { postMessage: vi.fn() }
    mod.attachThemeFaces(late)
    expect(late.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'register-face', family: 'Yomogi' }),
    )
    stop()
  })

  it('a face the realm could not register is not held, so nothing declares it', async () => {
    registerFontBytes.mockResolvedValueOnce('degraded' as never)
    const mod = await import('./theme-fonts.js')
    const { fetchFn } = daemonFetch([{ id: 'yomogi', family: 'Yomogi' }])
    expect(await mod.loadThemeFonts({ fetchFn, daemonBaseUrl: 'http://d' })).toEqual([])
    expect(mod.loadedThemeFaces()).toEqual([])
  })

  it('fetches a theme family from the catalogue source when no daemon holds it, once', async () => {
    // The browser keeper has no daemon, and a daemon nobody installed the
    // family on answers nothing: the same bytes the daemon would install come
    // straight from the catalogue's pinned source instead.
    const mod = await import('./theme-fonts.js')
    const calls: string[] = []
    const fetchFn = vi.fn(async (input: Request | string | URL) => {
      calls.push(String(input))
      return new Response(bytesOf('font:yomogi'), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    expect(await mod.loadThemeFontFromSource('Yomogi', fetchFn)).toBe(true)
    expect(calls).toEqual([
      'https://raw.githubusercontent.com/google/fonts/main/ofl/yomogi/Yomogi-Regular.ttf',
    ])
    expect(registerFontBytes).toHaveBeenCalledWith('Yomogi', bytesOf('font:yomogi'))
    expect(mod.loadedThemeFaces().map((f) => f.family)).toEqual(['Yomogi'])

    expect(await mod.loadThemeFontFromSource('Yomogi', fetchFn)).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('fetches nothing for a family the catalogue does not carry', async () => {
    const mod = await import('./theme-fonts.js')
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch
    expect(await mod.loadThemeFontFromSource('Comic Sans', fetchFn)).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('answers the family a canvas draws in under a style, so a surface can ask for it', async () => {
    const mod = await import('./theme-fonts.js')
    const sketched = {
      nodes: [],
      edges: [],
      'x-whiteboard': { facets: { 'visual.theme/v0': { theme: 'visual.sketch' } } },
    }
    const plain = { nodes: [], edges: [] }
    expect(mod.themeFamilyFor(sketched, undefined)).toBe('Yomogi')
    expect(mod.themeFamilyFor(sketched, 'document')).toBe('Yomogi')
    expect(mod.themeFamilyFor(sketched, 'clean')).toBeUndefined()
    expect(mod.themeFamilyFor(plain, 'visual.sketch')).toBe('Yomogi')
    expect(mod.themeFamilyFor(plain, undefined)).toBeUndefined()
    // Neon names no family: nothing to fetch.
    expect(mod.themeFamilyFor(plain, 'visual.neon')).toBeUndefined()
  })

  it('names the held faces an SVG actually declares, for the PNG export to embed', async () => {
    const mod = await import('./theme-fonts.js')
    const { fetchFn } = daemonFetch([{ id: 'yomogi', family: 'Yomogi' }])
    await mod.loadThemeFonts({ fetchFn, daemonBaseUrl: 'http://d' })
    expect(mod.themeFacesNamedBy('<svg><text font-family="Yomogi">a</text></svg>')).toHaveLength(1)
    expect(mod.themeFacesNamedBy('<svg><text font-family="Roboto">a</text></svg>')).toHaveLength(0)
  })
})
