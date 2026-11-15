import type { Finalizer } from './font-handles.js'

// A caller's content cache, kept in the core (owner decision q56): a layout
// names it by a surface id this module mints once per cache object and core,
// and the core keeps the bodies it lays out under that id. The id follows the
// object, so a caller that drops its cache (its contract when the measurer, the
// theme or the references change) names a new surface, and the old one is
// released once the object is collected.

/** The glue calls this module makes. */
export interface CachesGlue {
  release_layout_cache(surface: number): boolean
}

/** The most surfaces one core can name: a `u32`, as the request reads it. */
const MAX_SURFACE = 0xffff_ffff

/** The surfaces one core keeps, by the cache object each stands for. */
export class LayoutCaches {
  readonly #ids = new WeakMap<object, number>()
  readonly #collected: Finalizer
  #next = 0

  constructor(
    glue: CachesGlue,
    finalizer: (release: (surface: number) => void) => Finalizer = (release) =>
      new FinalizationRegistry(release),
  ) {
    this.#collected = finalizer((surface) => glue.release_layout_cache(surface))
  }

  /** The surface `cache` names, minted on its first layout; undefined once every id is spent. */
  surfaceOf(cache: object): number | undefined {
    const held = this.#ids.get(cache)
    if (held !== undefined) return held
    if (this.#next > MAX_SURFACE) return undefined
    const surface = this.#next
    this.#next += 1
    this.#ids.set(cache, surface)
    this.#collected.register(cache, surface, cache)
    return surface
  }
}
