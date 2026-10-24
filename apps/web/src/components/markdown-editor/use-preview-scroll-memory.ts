import { type RefObject, useEffect } from 'react'

/** Scroll offsets by history entry; a Back to an entry lands where it left. */
const offsets = new Map<string, number>()

/**
 * The browser's own entry key when it has one (react-router stamps each
 * entry), else the path. A fresh visit gets a new entry and so starts at the
 * top; only a return to the SAME entry restores.
 */
function entryKey(): string {
  const stamped: unknown = history.state?.key
  return typeof stamped === 'string' ? stamped : location.pathname
}

const RESTORE_FRAMES = 90

/**
 * Remembers the Read view's scroll offset per history entry and puts it back
 * when the editor mounts again. The preview typesets after mount, so the
 * offset is only reachable once the content is tall enough: restoring retries
 * per frame until it takes, and gives up on the first scroll the reader makes.
 */
export function usePreviewScrollMemory(previewScrollRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const key = entryKey()
    const target = offsets.get(key) ?? 0
    let settled = target === 0
    let frame = 0
    let raf = 0
    const attempt = () => {
      const preview = previewScrollRef.current
      if (preview !== null && preview.scrollHeight - preview.clientHeight >= target) {
        preview.scrollTop = target
        settled = true
        return
      }
      if (++frame < RESTORE_FRAMES) raf = requestAnimationFrame(attempt)
      else settled = true
    }
    if (!settled) raf = requestAnimationFrame(attempt)
    // Scroll does not bubble, and the preview element comes and goes with the
    // view mode, so one capturing listener on the document sees every one.
    const onScroll = (event: Event) => {
      if (event.target !== previewScrollRef.current) return
      const top = (event.target as HTMLElement).scrollTop
      if (settled) offsets.set(key, top)
    }
    const onReaderInput = () => {
      settled = true
      cancelAnimationFrame(raf)
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    document.addEventListener('wheel', onReaderInput, { passive: true })
    document.addEventListener('touchstart', onReaderInput, { passive: true })
    document.addEventListener('keydown', onReaderInput)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('scroll', onScroll, { capture: true })
      document.removeEventListener('wheel', onReaderInput)
      document.removeEventListener('touchstart', onReaderInput)
      document.removeEventListener('keydown', onReaderInput)
    }
  }, [previewScrollRef])
}
