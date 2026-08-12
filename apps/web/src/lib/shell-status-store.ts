// The AppShell is mounted once per App branch, above the routed pages, so a
// page that learns something shell-relevant (DaemonCanvasPage's live auth
// error) cannot pass it as a prop. This module store is that one signal's
// channel; keep it to shell concerns only.
let daemonAuthError = false
const listeners = new Set<() => void>()

export function subscribeShellStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getShellDaemonAuthError(): boolean {
  return daemonAuthError
}

export function setShellDaemonAuthError(next: boolean): void {
  if (next === daemonAuthError) return
  daemonAuthError = next
  for (const listener of listeners) listener()
}

export function resetShellStatusForTests(): void {
  daemonAuthError = false
  listeners.clear()
}
