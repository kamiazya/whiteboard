import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppLogger } from '@/lib/app-logger'

// Copy-URL confirmation: the button itself reports success/failure instead
// of a separate toast, since the affordance already has a fixed home (the
// canvas actions menu) and a transient label swap is enough signal.
export function useCopyCanvasUrl(canvasUrl: string, log?: AppLogger) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const copyStatusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(
    () => () => {
      mountedRef.current = false
      if (copyStatusTimeoutRef.current) clearTimeout(copyStatusTimeoutRef.current)
    },
    [],
  )

  const scheduleCopyStatusReset = useCallback((delayMs: number) => {
    if (copyStatusTimeoutRef.current) clearTimeout(copyStatusTimeoutRef.current)
    copyStatusTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) setCopyStatus('idle')
    }, delayMs)
  }, [])

  const resetCopyStatus = useCallback(() => setCopyStatus('idle'), [])

  const copyCanvasUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(canvasUrl)
      if (!mountedRef.current) return
      setCopyStatus('copied')
      scheduleCopyStatusReset(2000)
    } catch (err) {
      // A silent catch here is exactly the bug this fixes — clipboard access
      // can be denied (permissions, insecure context, browser refusal) and
      // must surface as a visible failure, not a false "copied" success.
      log?.error('failed to copy canvas URL to clipboard:', err)
      if (!mountedRef.current) return
      setCopyStatus('error')
      // Longer than the success state: the user needs time to read the
      // fallback instructions and select the URL manually.
      scheduleCopyStatusReset(8000)
    }
  }, [canvasUrl, log, scheduleCopyStatusReset])

  return { copyStatus, copyCanvasUrl, resetCopyStatus }
}
