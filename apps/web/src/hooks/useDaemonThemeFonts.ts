import { useEffect } from 'react'

/**
 * Fetches the families a theme names from whichever daemon the shell talks
 * to, once it is known, and again only when it changes: the faces are held
 * for the tab (`lib/theme-fonts.ts`), so a second pass is a list and
 * nothing else. Dynamic imports keep the shell's font machinery out of
 * `App`'s static closure, like the switcher source it sits beside.
 */
export function useDaemonThemeFonts(
  target: { readonly baseUrl: string; readonly token: string | undefined } | undefined,
): void {
  useEffect(() => {
    if (target === undefined) return
    void Promise.all([import('../lib/theme-fonts.js'), import('../lib/daemon-api-client.js')]).then(
      ([fonts, client]) =>
        fonts.loadThemeFonts({
          fetchFn: client.createDaemonFetch(target.baseUrl, target.token),
          daemonBaseUrl: target.baseUrl,
        }),
    )
  }, [target])
}
