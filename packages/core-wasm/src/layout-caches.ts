import type { Finalizer } from './font-handles.js'
import { finalizerPerGeneration, generationOf } from './recover.js'

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
  // Per generation: the core of a discarded instance holds nothing under the
  // surface, so a cache that outlives it is named anew.
  readonly #ids = new WeakMap<object, { surface: number; generation: number }>()
  readonly #glue: CachesGlue
  readonly #collected: () => Finalizer
  #next = 0

  constructor(
    glue: CachesGlue,
    finalizer: (release: (surface: number) => void) => Finalizer = (release) =>
      new FinalizationRegistry(release),
  ) {
    this.#glue = glue
    this.#collected = finalizerPerGeneration(glue, finalizer, (surface) =>
      glue.release_layout_cache(surface),
    )
  }

  /** The surface `cache` names, minted on its first layout; undefined once every id is spent. */
  surfaceOf(cache: object): number | undefined {
    const generation = generationOf(this.#glue)
    const held = this.#ids.get(cache)
    if (held !== undefined && held.generation === generation) return held.surface
    if (this.#next > MAX_SURFACE) return undefined
    const surface = this.#next
    this.#next += 1
    this.#ids.set(cache, { surface, generation })
    this.#collected().register(cache, surface, cache)
    return surface
  }
}

const BY_INSTANCE = new WeakMap<CachesGlue, LayoutCaches>()

/**
 * The surfaces `glue`'s instance names. One per glue, not per core:
 * wasm-bindgen's `initSync` answers the instance it already holds, so every
 * core built over one glue shares the instance's store, and two allocators
 * would hand two caches one surface.
 */
export function layoutCachesOf(glue: CachesGlue): LayoutCaches {
  let caches = BY_INSTANCE.get(glue)
  if (caches === undefined) {
    caches = new LayoutCaches(glue)
    BY_INSTANCE.set(glue, caches)
  }
  return caches
}
