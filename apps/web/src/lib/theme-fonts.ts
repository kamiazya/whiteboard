/**
 * The families a theme names, brought to this app from the daemon.
 *
 * ADR-0012's browser half, for exactly those families: the daemon keeps a
 * font the user installed as a file (what the export draws with), and this
 * module fetches the same bytes and registers them as a face — on the main
 * thread here, and in every layout worker through `attachThemeFaces` — so
 * the editor, the worker and the daemon's export measure the same glyphs.
 * Where no daemon holds the family, `loadThemeFontFromSource` fetches the
 * same file from the catalogue's pinned source, on a theme being USED —
 * never at startup, and never from the widget. Any other installed family
 * stays where it was: an export concern.
 *
 * A face is held once per family for the life of the tab. Nothing here is
 * awaited by a render: a layout asks `hasLoadedFace` and draws with the
 * bundled family until the answer changes, and `themeFontsGeneration` is
 * what tells a scene to lay out again when it does.
 */
import {
  SPATIAL_THEME_FONT_FAMILY,
  type SpatialRenderStyle,
} from '@kamiazya/whiteboard-canvas-render'
import { hasLoadedFace, registerFontBytes } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import {
  fontCatalogueEntryByFamily,
  fontDownloadUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/fonts'
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry, resolveCanvasTheme } from '@kamiazya/whiteboard-plugin-visual'
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
 * Fetches ONE theme family from the catalogue's pinned source — the same
 * bytes the daemon installs, so the two measure alike — for a realm no
 * daemon serves it to: a browser-kept workspace, or a daemon nobody
 * installed the family on. Resolves true when the face landed in THIS
 * call; false when it is already held, unknown to the catalogue, or failed
 * (logged; the layout keeps declaring the bundled family).
 *
 * Shares `inFlight` with the daemon pass, so whichever source asks first
 * is the one that lands and the other waits on it rather than fetching
 * again. The daemon's own export still draws what the daemon holds: this
 * reaches the editor, the workers and the browser's PNG export, and says
 * nothing about a face the daemon lacks.
 */
export async function loadThemeFontFromSource(
  family: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  if (faces.has(family)) return false
  const entry = fontCatalogueEntryByFamily(family)
  if (entry === undefined) return false
  const pending =
    inFlight.get(family) ??
    (async () => {
      try {
        const response = await fetchFn(fontDownloadUrl(entry))
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = await response.arrayBuffer()
        if ((await registerFontBytes(family, bytes)) !== 'loaded') return false
        hold(family, bytes)
        return true
      } catch (err) {
        log.warn(`could not load the theme family ${family} from its source`, err)
        return false
      } finally {
        inFlight.delete(family)
      }
    })()
  inFlight.set(family, pending)
  return pending
}

/**
 * The family a canvas is drawn in under a style, or undefined when the look
 * names none: `'clean'` never does, a theme id names that theme's, and the
 * document look names the canvas's own theme's. What a surface asks
 * `loadThemeFontFromSource` for — resolved here so the editor names no
 * facet domain and reads the same registry the layout does.
 */
export function themeFamilyFor(
  canvas: SpatialCanvas,
  style: SpatialRenderStyle | undefined,
  registry: FacetRegistry = bundledFacetRegistry,
): string | undefined {
  if (style === 'clean') return undefined
  const themeId =
    style === undefined || style === 'document' ? resolveCanvasTheme(canvas, registry) : style
  return themeId === undefined ? undefined : registry.themeAsset(themeId)?.fontFamily
}

/**
 * The family an in-place text editor types in: the theme's where this realm
 * holds its face — exactly where the layout declares it (`fontAvailable`)
 * — and the bundled family otherwise. Typing in a family the scene does not
 * draw makes the draft move on commit, so the overlay follows the same rule
 * rather than the theme's wish.
 */
export function editingFontFamilyFor(
  canvas: SpatialCanvas,
  style: SpatialRenderStyle | undefined,
  registry: FacetRegistry = bundledFacetRegistry,
): string {
  const family = themeFamilyFor(canvas, style, registry)
  return family !== undefined && hasLoadedFace(family) ? family : SPATIAL_THEME_FONT_FAMILY
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
