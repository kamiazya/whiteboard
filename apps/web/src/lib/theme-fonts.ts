/**
 * The families a theme names, brought to this app from the daemon.
 *
 * ADR-0012's browser half, for exactly those families: the daemon keeps a
 * font the user installed as a file (what the export draws with), and this
 * module fetches the same bytes and registers them as a face — on the main
 * thread here, and in every layout worker through `attachThemeFaces` — so
 * the editor, the worker and the daemon's export measure the same glyphs.
 * Any other installed family stays where it was: an export concern.
 *
 * A face is held once per family for the life of the tab. Nothing here is
 * awaited by a render: a layout asks `hasLoadedFace` and draws with the
 * bundled family until the answer changes, and `themeFontsGeneration` is
 * what tells a scene to lay out again when it does.
 */
import { registerFontBytes } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { getAppLogger } from './app-logger.js'
import { fetchFontFile, listFonts } from './daemon-api-client.js'

const log = getAppLogger('theme-fonts')

export interface ThemeFace {
  readonly family: string
  readonly bytes: ArrayBuffer
}

/** What a worker receives for each face this realm holds. */
export interface RegisterFaceMessage {
  readonly type: 'register-face'
  readonly family: string
  readonly bytes: ArrayBuffer
}

const faces = new Map<string, ArrayBuffer>()
let generation = 0
const subscribers = new Set<() => void>()
const inFlight = new Map<string, Promise<boolean>>()

/** Every family a registered theme names — the only ones this module fetches. */
export function themeFontFamilies(
  registry: FacetRegistry = bundledFacetRegistry,
): readonly string[] {
  const families = new Set<string>()
  for (const id of registry.assetIds('themes')) {
    const family = registry.themeAsset(id)?.fontFamily
    if (family !== undefined) families.add(family)
  }
  return [...families]
}

export function loadedThemeFaces(): readonly ThemeFace[] {
  return [...faces].map(([family, bytes]) => ({ family, bytes }))
}

/** Bumps once per face that landed; a scene keyed on it lays out again. */
export function themeFontsGeneration(): number {
  return generation
}

export function subscribeThemeFonts(callback: () => void): () => void {
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
  }
}

function hold(family: string, bytes: ArrayBuffer): void {
  faces.set(family, bytes)
  generation += 1
  for (const callback of subscribers) callback()
}

/**
 * Fetches and registers the installed theme families this realm does not
 * hold yet. Resolves with the families that landed in THIS call. A font
 * that fails to arrive or to register is logged and skipped — the layout
 * keeps declaring the bundled family, which is the declared degradation.
 */
export async function loadThemeFonts(options: {
  readonly fetchFn: typeof globalThis.fetch
  readonly daemonBaseUrl: string
  readonly families?: readonly string[]
}): Promise<readonly string[]> {
  const wanted = new Set(options.families ?? themeFontFamilies())
  let fonts: Awaited<ReturnType<typeof listFonts>>['fonts']
  try {
    fonts = (await listFonts(options.fetchFn, options.daemonBaseUrl)).fonts
  } catch (err) {
    // Routine rather than a failure: the daemon is asked for the first time
    // while a connection is still settling, and every later render keeps
    // drawing the bundled family until a pass succeeds.
    log.info('could not list the daemon fonts; theme families stay unloaded', err)
    return []
  }
  const landed: string[] = []
  for (const font of fonts) {
    if (!font.installed || !wanted.has(font.family) || faces.has(font.family)) continue
    const pending =
      inFlight.get(font.family) ??
      (async () => {
        try {
          const bytes = await fetchFontFile(options.fetchFn, options.daemonBaseUrl, font.id)
          if ((await registerFontBytes(font.family, bytes)) !== 'loaded') return false
          hold(font.family, bytes)
          return true
        } catch (err) {
          log.warn(`could not load the theme family ${font.family}`, err)
          return false
        } finally {
          inFlight.delete(font.family)
        }
      })()
    inFlight.set(font.family, pending)
    if (await pending) landed.push(font.family)
  }
  return landed
}

/**
 * Keeps one worker's face set equal to this realm's: every face held now is
 * posted at once, and every face that lands later follows. Returns the
 * detach, for a worker being retired.
 */
export function attachThemeFaces(worker: {
  postMessage(message: RegisterFaceMessage): void
}): () => void {
  const post = (family: string, bytes: ArrayBuffer) =>
    worker.postMessage({ type: 'register-face', family, bytes })
  const posted = new Set<string>()
  const sync = () => {
    for (const [family, bytes] of faces) {
      if (posted.has(family)) continue
      posted.add(family)
      post(family, bytes)
    }
  }
  sync()
  return subscribeThemeFonts(sync)
}

/** The held faces an SVG names in a `font-family` attribute — what a PNG export must carry. */
export function themeFacesNamedBy(svg: string): readonly ThemeFace[] {
  return loadedThemeFaces().filter((face) => svg.includes(`font-family="${face.family}"`))
}
