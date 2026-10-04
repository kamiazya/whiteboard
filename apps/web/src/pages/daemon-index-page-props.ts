import type { SseStreamSource } from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'

export interface DaemonIndexPageProps {
  daemonBaseUrl: string
  token?: string
  /**
   * The workspace the ADDRESS names, in either of ADR-0019's resolvable
   * layers. Absent when the address names none — `/`, or a workspace-level
   * link without one — and the page then falls back to the daemon's
   * first-listed workspace and reports what it settled on.
   *
   * Not an `initialWorkspaceId`: the page does not OWN the choice through a
   * select of its own, so the prop is not read once at mount. The one
   * switcher is the shell's, and it moves the address — so the prop changes
   * under a mounted page, and the page follows it.
   */
  workspace?: string
  /**
   * The workspace this page settled on — the initial resolve as well as every
   * later switch. The address bar is App's to write, and until this existed it
   * had nothing to write WITH: `/` names no workspace, the page picked one
   * anyway, and the two disagreed for the rest of the session.
   */
  onWorkspaceResolved?: (workspace: string) => void
  onOpenDocument: (workspaceId: string, path: string) => void
  /** Served by a server-mode keeper (ADR-0047), so the copy names a server. */
  serverMode?: boolean
  /**
   * The stream the list follows the workspace through. Absent, the page uses
   * the shared one the document page syncs over, and a stream of its own
   * where the browser has none to share.
   */
  streamSource?: SseStreamSource
}
