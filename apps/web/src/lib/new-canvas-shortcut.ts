const KEY = 'new'
const VALUE = 'canvas'

/**
 * The installed app's "New canvas" launcher shortcut, declared once: the PWA
 * manifest (`vite-pwa-options.ts`) publishes its `url` and the browser
 * keeper's document list reads its parameter. Spelled per side, a rename on
 * either leaves the launcher opening the plain list with every test green.
 *
 * DOM-free, because the build config imports it. One object rather than one
 * export per member, so the build config's read and the page's are reads of
 * the same export.
 */
export const NEW_CANVAS_SHORTCUT = {
  key: KEY,
  value: VALUE,
  /** The manifest's shortcut URL: the app's root, carrying the parameter. */
  url: `/?${KEY}=${VALUE}`,
  /** Whether an address's parameters ask for a new canvas. */
  isRequestedBy(params: URLSearchParams): boolean {
    return params.get(KEY) === VALUE
  },
  /** The same parameters without the shortcut's, so a reload or Back cannot create again. */
  removedFrom(params: URLSearchParams): URLSearchParams {
    const rest = new URLSearchParams(params)
    rest.delete(KEY)
    return rest
  },
} as const
