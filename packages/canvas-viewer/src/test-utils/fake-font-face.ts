// jsdom implements neither the FontFace constructor nor document.fonts, so
// every jsdom-project test of the font-loading module installs these fakes
// before importing a fresh module instance (ensureViewerFontLoaded memoizes
// its promise at module scope, so the import must follow vi.resetModules()).

export interface FakeFontFaceDeferred {
  resolve: () => void
  reject: (err: unknown) => void
}

export class FakeFontFace {
  readonly loadDeferred: FakeFontFaceDeferred
  private readonly loadPromise: Promise<FakeFontFace>

  constructor(
    public family: string,
    public source: string,
  ) {
    let resolve!: () => void
    let reject!: (err: unknown) => void
    this.loadPromise = new Promise<FakeFontFace>((res, rej) => {
      resolve = () => res(this)
      reject = rej
    })
    this.loadDeferred = { resolve, reject }
  }

  load(): Promise<FakeFontFace> {
    return this.loadPromise
  }
}

/**
 * Installs FakeFontFace as the global FontFace and a minimal document.fonts,
 * returning the array every registered face is pushed into.
 */
export function installFakeFontApis(): { added: FakeFontFace[] } {
  const added: FakeFontFace[] = []
  ;(globalThis as unknown as { FontFace: unknown }).FontFace = FakeFontFace
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add(face: FakeFontFace) {
        added.push(face)
      },
    },
  })
  return { added }
}

/** Removes the global installed by installFakeFontApis (afterEach teardown). */
export function uninstallFakeFontApis(): void {
  delete (globalThis as unknown as { FontFace?: unknown }).FontFace
}
