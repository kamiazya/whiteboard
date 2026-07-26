// @excalidraw/excalidraw's App component registers a `window` `unload`
// listener in componentDidMount (its onUnload handler delegates to the same
// teardown as its own blur handler). Chrome's Permissions-Policy already
// refuses to fire `unload` and logs a console violation for registering it
// at all — our own durable persistence lives in useWhiteboardSync's
// continuous flush, not in that handler, so nothing is lost by never
// letting the native listener attach. This shim transparently redirects any
// `unload` registration to `pagehide` (which still fires, unlike `unload`)
// before Excalidraw mounts, so its teardown still runs and no console
// violation appears.
//
// Patches `window` directly (an own-property override, not
// `EventTarget.prototype`): Excalidraw's listener registration
// (`Ae(window, "unload", this.onUnload, …)`) always calls through
// `window.addEventListener`, and scoping the patch to the `window` instance
// keeps every other EventTarget (document, DOM elements, custom emitters)
// completely unaffected.
const UNLOAD_EVENT = 'unload'
const REPLACEMENT_EVENT = 'pagehide'

type ListenerArgs = Parameters<typeof window.addEventListener>

function mapEventType(type: ListenerArgs[0]): ListenerArgs[0] {
  return type === UNLOAD_EVENT ? REPLACEMENT_EVENT : type
}

interface TranslatedListener {
  listener: ListenerArgs[1]
  options: ListenerArgs[2]
}

/**
 * Installs the unload→pagehide translation on `window`.
 * Returns an uninstall function that restores the original methods.
 */
export function installUnloadShim(): () => void {
  const originalAdd = window.addEventListener.bind(window)
  const originalRemove = window.removeEventListener.bind(window)
  // Tracks listeners the shim translated to `pagehide` so uninstall() can
  // detach them explicitly — once the native methods are restored,
  // `removeEventListener('unload', fn)` targets the (never-registered)
  // native 'unload' type and can no longer reach the translated listener.
  const translatedListeners: TranslatedListener[] = []

  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    const mappedType = mapEventType(type)
    if (mappedType === REPLACEMENT_EVENT && type === UNLOAD_EVENT) {
      translatedListeners.push({ listener, options })
    }
    return originalAdd(mappedType, listener, options)
  }) as typeof window.addEventListener

  window.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    if (type === UNLOAD_EVENT) {
      // Drop the tracking record so re-add/remove cycles (Excalidraw does
      // this on editor-mode changes) don't accumulate and uninstall doesn't
      // re-detach an already-removed listener. Match by listener + capture
      // flag, mirroring how the DOM identifies listener entries.
      const capture = typeof options === 'boolean' ? options : (options?.capture ?? false)
      const index = translatedListeners.findIndex((entry) => {
        const entryCapture =
          typeof entry.options === 'boolean' ? entry.options : (entry.options?.capture ?? false)
        return entry.listener === listener && entryCapture === capture
      })
      if (index !== -1) translatedListeners.splice(index, 1)
    }
    return originalRemove(mapEventType(type), listener, options)
  }) as typeof window.removeEventListener

  return function uninstallUnloadShim() {
    for (const { listener, options } of translatedListeners) {
      originalRemove(REPLACEMENT_EVENT, listener, options)
    }
    window.addEventListener = originalAdd
    window.removeEventListener = originalRemove
  }
}
