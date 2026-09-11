import { hasLoadedFace, registerFontBytes } from '../font-loading.js'

/**
 * The ONE origin this widget will ever request, pinned in the widget rather
 * than taken from the payload it arrives beside.
 *
 * A theme names a family; the catalogue that knows where that family's bytes
 * live is the daemon's (`FONT_SOURCE_ORIGIN` in daemon-client), and the URL
 * reaches here through `canvas_view`'s result so nothing but a string ever
 * crosses the model's context. Re-checking the origin here is what stops a
 * host — or anything that can put a value in that result — from turning the
 * widget into a fetch of its choosing: the widget is sandboxed markup with
 * no daemon credentials, and its one outbound request has to stay one it
 * could have written itself.
 */
const WIDGET_FONT_SOURCE_ORIGIN = 'https://raw.githubusercontent.com'

/**
 * `present` — this realm already holds the face, so nothing was requested.
 * `refused` — the URL was not on the pinned origin; nothing was requested.
 * `degraded` — requested and did not arrive: the host narrowed CSP, the
 * fetch failed, or the bytes are not a font.
 *
 * Only `loaded` is worth redrawing for.
 */
export type ThemeFontOutcome = 'loaded' | 'present' | 'refused' | 'degraded'

export interface ThemeFont {
  readonly family: string
  readonly url: string
}

/**
 * Fetches a theme's family and registers it in this realm, so the next
 * layout can declare it (canvas-render's `fontAvailable` seam).
 *
 * Never throws and never blocks a draw: the scene is already on screen in
 * the bundled family, which is the degradation ADR-0030 already declares.
 */
export async function loadThemeFont(themeFont: ThemeFont): Promise<ThemeFontOutcome> {
  if (hasLoadedFace(themeFont.family)) return 'present'
  let origin: string
  try {
    origin = new URL(themeFont.url).origin
  } catch {
    return 'refused'
  }
  if (origin !== WIDGET_FONT_SOURCE_ORIGIN) {
    console.error(
      '[whiteboard-widget] refusing a theme font URL outside the catalogue origin:',
      themeFont.url,
    )
    return 'refused'
  }
  try {
    const response = await fetch(themeFont.url)
    if (!response.ok) return 'degraded'
    return await registerFontBytes(themeFont.family, await response.arrayBuffer())
  } catch {
    // A host that narrows CSP rejects the fetch here. That is a supported
    // outcome, not a failure to report: the widget keeps the bundled family.
    return 'degraded'
  }
}
