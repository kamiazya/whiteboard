// Fullscreen detection helpers for CanvasPage.
//
// Two URL forms are accepted:
//   • `#fullscreen` (current) — fragment-only, so re-opening the same canvas
//     fires `hashchange` instead of a real navigation. The page never reloads,
//     in-page state (dialogs, tooltips, history popovers) is preserved, and
//     any beforeunload listener registered by the page or libraries cannot
//     interject.
//   • `?fullscreen=1` (legacy) — read on mount only, kept for back-compat
//     with existing transcripts and bookmarks. The hash form is what
//     `canvas_open` emits going forward.

const FULLSCREEN_HASH = '#fullscreen'

export function isFullscreenHash(hash: string): boolean {
  return hash === FULLSCREEN_HASH
}

export function detectInitialFullscreen(args: {
  search: URLSearchParams | string
  hash: string
}): boolean {
  if (isFullscreenHash(args.hash)) return true
  const params = typeof args.search === 'string' ? new URLSearchParams(args.search) : args.search
  return params.get('fullscreen') === '1'
}
