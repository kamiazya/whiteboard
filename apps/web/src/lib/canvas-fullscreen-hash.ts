// Mirrors the locally-toggled `isFullscreen` state into the URL hash
// without disturbing other hashes.
//
// Background: the canvas page can be opened with payload-bearing hashes
// like `#addLibrary=…` (Excalidraw library import return flow). The
// previous implementation wrote `''` whenever isFullscreen was false,
// which clobbered those hashes on initial mount before the consuming
// effect could read them.
//
// Contract:
//   • When isFullscreen flips on  → write `#fullscreen` (overwrites any
//     pre-existing hash because the user explicitly switched modes).
//   • When isFullscreen flips off → clear the hash *only* if the current
//     hash is `#fullscreen`. Any other hash is left alone so its owner
//     can still consume it.
//   • Idempotent: skip the History call when the hash already matches.
//
// Extracted as a pure helper so the regression has a unit test that does
// not need a live React tree.

const FULLSCREEN_HASH = '#fullscreen'

export interface FullscreenHashTarget {
  location: {
    readonly pathname: string
    readonly search: string
    readonly hash: string
  }
  history: {
    replaceState(state: unknown, unused: string, url: string): void
    readonly state: unknown
  }
}

export function syncFullscreenHash(isFullscreen: boolean, target: FullscreenHashTarget): void {
  const currentHash = target.location.hash
  if (isFullscreen) {
    if (currentHash === FULLSCREEN_HASH) return
    const url = `${target.location.pathname}${target.location.search}${FULLSCREEN_HASH}`
    target.history.replaceState(target.history.state, '', url)
    return
  }
  // Non-fullscreen: only clean up our own marker. Leaving foreign hashes
  // untouched is the whole point of this helper.
  if (currentHash !== FULLSCREEN_HASH) return
  const url = `${target.location.pathname}${target.location.search}`
  target.history.replaceState(target.history.state, '', url)
}
