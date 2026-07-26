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

/**
 * Installs the unload→pagehide translation on `window`.
 * Returns an uninstall function that restores the original methods.
 */
export function installUnloadShim(): () => void {
  const originalAdd = window.addEventListener.bind(window)
  const originalRemove = window.removeEventListener.bind(window)

  window.addEventListener = ((...args: ListenerArgs) => {
    const [type, listener, options] = args
    const mappedType = type === UNLOAD_EVENT ? REPLACEMENT_EVENT : type
    return originalAdd(mappedType, listener, options)
  }) as typeof window.addEventListener

  window.removeEventListener = ((...args: ListenerArgs) => {
    const [type, listener, options] = args
    const mappedType = type === UNLOAD_EVENT ? REPLACEMENT_EVENT : type
    return originalRemove(mappedType, listener, options)
  }) as typeof window.removeEventListener

  return function uninstallUnloadShim() {
    window.addEventListener = originalAdd
    window.removeEventListener = originalRemove
  }
}
