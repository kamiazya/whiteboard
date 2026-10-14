/** The slice of ext-apps' `App` that opening a link needs. */
interface LinkHost {
  getHostCapabilities(): { openLinks?: unknown } | undefined
  openLink(params: { url: string }): Promise<unknown>
}

export interface SceneLinkGuard {
  /** Hands scheme URLs to `host` from now on, when it advertises `openLinks`. */
  openThrough(host: LinkHost): void
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Keeps every link drawn in the widget from navigating the widget's own
 * frame. A followed link replaces the view — canvas, Refresh and the comment
 * form — until the chat re-renders the tool result, and a document link (a
 * bare id the renderer writes) resolves against the frame's URL to nothing.
 *
 * A URL with a scheme is handed to the host, which opens it outside the
 * frame or refuses; nothing else has anywhere to go, so it does nothing. A
 * click on a link is about the link, so it never reaches click-to-anchor.
 * Capturing, on the container, because every refresh replaces the SVG.
 */
export function guardSceneLinks(container: HTMLElement): SceneLinkGuard {
  let host: LinkHost | undefined
  container.addEventListener(
    'click',
    (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (anchor === null) return
      event.preventDefault()
      event.stopPropagation()
      const href = anchor.getAttribute('href') ?? ''
      // A document link is a bare id or `#id`, so it never has a scheme.
      if (!URL_SCHEME.test(href)) return
      if (host?.getHostCapabilities()?.openLinks === undefined) return
      host.openLink({ url: href }).catch((err: unknown) => {
        console.error('[whiteboard-widget] openLink via host failed:', err)
      })
    },
    { capture: true },
  )
  return {
    openThrough: (next) => {
      host = next
    },
  }
}
