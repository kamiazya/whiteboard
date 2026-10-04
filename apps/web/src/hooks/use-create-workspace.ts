import { useRef, useState } from 'react'
import { createFailureCopy } from '../lib/workspace-create-failure.js'
import { workspaceHandle } from '../lib/workspace-handle.js'
import type { KeeperWorkspaces } from '../lib/workspace-switcher-source.js'

/**
 * The create call and what it leaves behind — busy, and the words for a
 * failure — for every "New workspace" form. A failed create leaves the form
 * as the person typed it and can be tried again.
 */
export function useCreateWorkspace(
  { source, onSwitch }: KeeperWorkspaces,
  { onCreated }: { readonly onCreated?: () => void } = {},
) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A ref beside `busy`: state is a snapshot, so a second submit dispatched
  // before React re-renders still reads it false, and each create mints a
  // workspace the person then has to find and be rid of.
  const submitting = useRef(false)
  const submit = (typed: string) => {
    const displayName = typed.trim()
    if (source.create === undefined || displayName === '' || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    source
      .create(displayName)
      .then((created) => {
        // Released on success too: `onSwitch` is an in-SPA route change for
        // the browser keeper, so the form may survive the navigation, and a
        // guard still held would leave it open with Create disabled.
        submitting.current = false
        setBusy(false)
        onCreated?.()
        // The handle the keeper answered with, never the typed name: the
        // address is derived from it and may be suffixed or absent.
        onSwitch(workspaceHandle(created))
      })
      .catch((cause: unknown) => {
        submitting.current = false
        setBusy(false)
        setError(createFailureCopy(cause))
      })
  }
  return { busy, error, submit, clearError: () => setError(null) }
}
